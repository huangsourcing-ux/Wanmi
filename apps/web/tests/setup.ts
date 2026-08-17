import 'dotenv/config'

import { randomBytes, randomUUID } from 'node:crypto'

process.env.ALLOW_REAL_PROVIDER_WRITES = 'false'
process.env.ALLOW_REAL_ALIYUN_OSS_REALNAME = 'false'
process.env.ALLOW_REAL_ALIYUN_SMS_SENDS = 'false'
process.env.ALLOW_REAL_WECHAT_OFFICIAL_MESSAGES = 'false'
process.env.ALLOW_REAL_WECHATPAY = 'false'
process.env.ALLOW_REAL_WECHATPAY_PAYMENTS = 'false'
process.env.ALLOW_REAL_WECHATPAY_REFUNDS = 'false'
process.env.ALLOW_REAL_WESTDIGITAL = 'false'
process.env.ALLOW_REAL_WESTDIGITAL_DNS_WRITES = 'false'
process.env.ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES = 'false'
process.env.ALLOW_REAL_WESTDIGITAL_READS = 'false'
process.env.ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES = 'false'
process.env.ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES = 'false'
process.env.ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES = 'false'
process.env.ALIYUN_OSS_REALNAME_MODE = 'mock'
process.env.ALIYUN_CAPTCHA_MODE = 'fixture'
process.env.ALIYUN_SMS_MODE = 'mock'
process.env.DATABASE_URL ??= 'postgresql://wanmi:wanmi_local_only@127.0.0.1:55432/wanmi'
process.env.NEXT_PUBLIC_SERVER_URL = 'http://127.0.0.1:3000'
process.env.PAYLOAD_SECRET = 'test-payload-secret-at-least-32-bytes'
process.env.PUBLIC_STORAGE_MODE = 's3'
process.env.REALNAME_DOCUMENT_MASTER_KEYS = `test-v1:${randomBytes(32).toString('base64')}`
process.env.REALNAME_DOCUMENT_MASTER_KEY_VERSION = 'test-v1'
process.env.S3_ACCESS_KEY_ID = 'wanmi-minio'
process.env.S3_BUCKET = 'wanmi-public'
process.env.S3_ENDPOINT = 'http://127.0.0.1:9000'
process.env.S3_FORCE_PATH_STYLE = 'true'
process.env.S3_REGION = 'us-east-1'
process.env.S3_SECRET_ACCESS_KEY = 'wanmi-minio-local-only'
process.env.SESSION_PEPPER = 'test-session-pepper-at-least-32-bytes'
process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.WHO_DAT_URL = 'http://127.0.0.1:8080'
process.env.WECHATPAY_MODE = 'fixture'
process.env.WECHAT_OFFICIAL_MODE = 'fixture'
process.env.WECHAT_OFFICIAL_APP_ID = `wx-${randomUUID()}`
process.env.WECHAT_OFFICIAL_APP_SECRET = randomBytes(24).toString('base64url')
process.env.WECHAT_OFFICIAL_CALLBACK_TOKEN = randomBytes(24).toString('base64url')
process.env.WECHAT_OFFICIAL_ENCODING_AES_KEY = randomBytes(32).toString('base64').slice(0, 43)
process.env.WECHAT_OFFICIAL_OAUTH_DOMAIN = '127.0.0.1'
process.env.WESTDIGITAL_MODE = 'fixture'
