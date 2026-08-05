import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { adminLoginResponseSchema, adminLoginSchema } from '@/schemas/auth'
import { loginAdmin } from '@/services/auth/admin-session'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = adminLoginSchema.parse(await request.json())
    const result = await loginAdmin(request, input)
    return successResponse(adminLoginResponseSchema.parse({ admin: result.admin }), traceId, {
      headers: { 'set-cookie': result.cookie },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
