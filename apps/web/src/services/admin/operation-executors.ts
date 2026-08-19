import type { PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'
import { adminApprovalCreateSchema, type AdminApprovalCreateInput } from '@/schemas/admin-approvals'
import { decideAccountRecovery } from '@/services/auth/account-recovery'
import { transitionCustomerAccount } from '@/services/auth/account-state'
import { decideCustomerIdentityCollision } from '@/services/auth/customer-identities'
import { requestAutomaticRegistrationFailureRefund } from '@/services/commerce/refunds'
import { loadWalletFundsPolicy } from '@/services/wallet/policy'
import { postWalletCredit, recoverWalletBalance } from '@/services/wallet/ledger'

import {
  executeAdminApprovalRequest,
  getAdminApprovalRequest,
  type AdminApprovalRecord,
} from './approvals'

function relationId(value: number | string | { id: number | string }): number | string {
  return typeof value === 'object' ? value.id : value
}

function approvalInput(approval: AdminApprovalRecord): AdminApprovalCreateInput {
  return adminApprovalCreateSchema.parse({
    ...approval.operationData,
    ...(approval.operationType === 'large_balance_adjustment'
      ? { amountFen: approval.amountFen }
      : {}),
    customerId: Number(relationId(approval.customer)),
    operationType: approval.operationType,
    reasonNote: approval.reasonNote,
  })
}

async function assertWalletAccountOwner(
  req: PayloadRequest,
  accountId: number | string,
  customerId: number,
): Promise<void> {
  const account = await req.payload.findByID({
    collection: 'walletAccounts',
    depth: 0,
    id: accountId,
    overrideAccess: true,
    req,
  })
  if (
    String(relationId(account.customer as number | string | { id: number | string })) !==
      String(customerId) ||
    account.currency !== 'CNY'
  ) {
    throw new AppError('ADMIN_WALLET_ACCOUNT_OWNER_MISMATCH', '钱包账户归属或币种不匹配', 409)
  }
}

async function assertOrderOwner(
  req: PayloadRequest,
  orderId: number | string,
  customerId: number,
): Promise<void> {
  const order = await req.payload.findByID({
    collection: 'orders',
    depth: 0,
    id: orderId,
    overrideAccess: true,
    req,
  })
  if (
    String(relationId(order.customer as number | string | { id: number | string })) !==
    String(customerId)
  ) {
    throw new AppError('ADMIN_REFUND_ORDER_OWNER_MISMATCH', '退款订单归属不匹配', 409)
  }
}

async function withApprovalContext<T>(
  req: PayloadRequest,
  marker: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = req.context.adminApprovalExecution
  req.context.adminApprovalExecution = marker
  try {
    return await work()
  } finally {
    req.context.adminApprovalExecution = previous
  }
}

export async function executeSupportedAdminOperation(
  req: PayloadRequest,
  requestId: number | string,
) {
  const approval = await getAdminApprovalRequest(req, requestId)
  switch (approval.operationType) {
    case 'large_balance_adjustment':
      return executeAdminApprovalRequest(
        req,
        { expectedOperationType: approval.operationType, requestId },
        async (claimed) => {
          const input = approvalInput(claimed)
          if (input.operationType !== 'large_balance_adjustment') throw new Error('unreachable')
          await assertWalletAccountOwner(req, input.accountId, input.customerId)
          if (input.adjustment === 'credit') {
            const policy = await loadWalletFundsPolicy(req)
            return postWalletCredit(req, {
              accountId: input.accountId,
              amountFen: input.amountFen,
              maximumPostedBalanceFen: policy.accountBalanceLimitFen,
              transactionKey: input.transactionKey,
            })
          }
          return recoverWalletBalance(req, {
            accountId: input.accountId,
            allowNegativeBalance: input.allowNegativeBalance,
            amountFen: input.amountFen,
            transactionKey: input.transactionKey,
          })
        },
      )
    case 'original_refund':
      return executeAdminApprovalRequest(
        req,
        { expectedOperationType: approval.operationType, requestId },
        async (claimed) => {
          const input = approvalInput(claimed)
          if (input.operationType !== 'original_refund') throw new Error('unreachable')
          await assertOrderOwner(req, input.orderId, input.customerId)
          return requestAutomaticRegistrationFailureRefund(req, {
            evidence: { adminApprovalRequestId: String(claimed.id) },
            note: input.reasonNote,
            orderId: input.orderId,
            traceId: `admin-approval-refund:${claimed.requestKey}`,
            transition: {
              actorId: String(req.user!.id),
              actorType: 'admin',
              reasonCode: 'admin.approved_original_refund',
            },
          })
        },
      )
    case 'account_recovery':
      return executeAdminApprovalRequest(
        req,
        { expectedOperationType: approval.operationType, requestId },
        async (claimed) => {
          const input = approvalInput(claimed)
          if (input.operationType !== 'account_recovery') throw new Error('unreachable')
          return withApprovalContext(req, `account_recovery:${input.reviewId}`, () =>
            decideAccountRecovery(req, {
              decision: { conclusion: input.decision, note: input.reasonNote },
              reviewId: input.reviewId,
              reviewerId: req.user!.id,
              traceId: `admin-approval-recovery:${claimed.requestKey}`,
            }),
          )
        },
      )
    case 'identity_conflict_resolution':
      return executeAdminApprovalRequest(
        req,
        { expectedOperationType: approval.operationType, requestId },
        async (claimed) => {
          const input = approvalInput(claimed)
          if (input.operationType !== 'identity_conflict_resolution') throw new Error('unreachable')
          return withApprovalContext(req, `identity_conflict_resolution:${input.reviewId}`, () =>
            decideCustomerIdentityCollision(req, {
              customerId: input.customerId,
              note: input.reasonNote,
              resolution: input.resolution,
              reviewId: input.reviewId,
              reviewerId: req.user!.id,
            }),
          )
        },
      )
    case 'high_risk_account_unfreeze':
      return executeAdminApprovalRequest(
        req,
        { expectedOperationType: approval.operationType, requestId },
        async (claimed) => {
          const input = approvalInput(claimed)
          if (input.operationType !== 'high_risk_account_unfreeze') throw new Error('unreachable')
          return withApprovalContext(req, `high_risk_account_unfreeze:${input.customerId}`, () =>
            transitionCustomerAccount(req, {
              actor: { id: req.user!.id, type: 'admin' },
              customerId: input.customerId,
              evidence: {
                observedAt: new Date().toISOString(),
                reference: input.evidenceReference,
                source: 'manual_review',
              },
              expectedRestrictions: input.expectedRestrictions,
              expectedStatus: input.expectedStatus,
              reason: input.reasonNote,
              restrictions: [],
              status: 'active',
            }),
          )
        },
      )
    case 'vip_fraud_correction':
    case 'domain_management_credential_disposition':
    case 'bulk_customer_asset_operation':
      throw new AppError(
        'ADMIN_OPERATION_DOMAIN_EXECUTOR_REQUIRED',
        '该审批必须由对应领域服务执行，禁止通用入口代替业务动作',
        409,
      )
  }
}
