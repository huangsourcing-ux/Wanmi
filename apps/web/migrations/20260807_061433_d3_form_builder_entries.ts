import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_form_submissions_purpose" AS ENUM('contact', 'feedback', 'request');
  CREATE TYPE "public"."enum_form_submissions_tool" AS ENUM('domain-search', 'whois', 'dns', 'ssl-check', 'idn', 'pricing');
  CREATE TYPE "public"."enum_form_submissions_status" AS ENUM('new', 'reviewed', 'closed');
  ALTER TABLE "form_submissions" ADD COLUMN "purpose" "enum_form_submissions_purpose";
  ALTER TABLE "form_submissions" ADD COLUMN "summary" varchar;
  ALTER TABLE "form_submissions" ADD COLUMN "contact_masked" varchar;
  ALTER TABLE "form_submissions" ADD COLUMN "page_path" varchar;
  ALTER TABLE "form_submissions" ADD COLUMN "tool" "enum_form_submissions_tool";
  ALTER TABLE "form_submissions" ADD COLUMN "request_id" varchar;
  ALTER TABLE "form_submissions" ADD COLUMN "status" "enum_form_submissions_status" DEFAULT 'new' NOT NULL;
  ALTER TABLE "form_submissions" ADD COLUMN "trace_id" varchar;
  ALTER TABLE "form_submissions" ADD COLUMN "client_key_hash" varchar;
  ALTER TABLE "form_submissions" ADD COLUMN "status_updated_at" timestamp(3) with time zone;
  ALTER TABLE "form_submissions" ADD COLUMN "status_updated_by_id" integer;
  UPDATE "form_submissions" submission
  SET
    "purpose" = form_record."purpose"::text::"enum_form_submissions_purpose",
    "summary" = '[遗留提交，待系统管理员复核]',
    "trace_id" = 'legacy-form-submission-' || submission."id"::text,
    "client_key_hash" = 'legacy-' || md5('form-submission:' || submission."id"::text)
  FROM "forms" form_record
  WHERE submission."form_id" = form_record."id";
  UPDATE "form_submissions_submission_data"
  SET "value" = '[遗留内容已隐藏，待人工复核]'
  WHERE "value" ~ '[<>]'
     OR lower("field") IN ('domain', 'domainascii', 'fulldomain', 'query', 'querydomain');
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM "form_submissions"
      WHERE "purpose" IS NULL OR "summary" IS NULL OR "trace_id" IS NULL OR "client_key_hash" IS NULL
    ) THEN
      RAISE EXCEPTION 'D3-05 cannot safely backfill legacy form submissions without a valid form relation';
    END IF;
    IF EXISTS (SELECT 1 FROM "forms" GROUP BY "purpose" HAVING COUNT(*) > 1) THEN
      RAISE EXCEPTION 'D3-05 requires at most one managed form per purpose';
    END IF;
  END $$;
  ALTER TABLE "form_submissions" ALTER COLUMN "purpose" SET NOT NULL;
  ALTER TABLE "form_submissions" ALTER COLUMN "summary" SET NOT NULL;
  ALTER TABLE "form_submissions" ALTER COLUMN "trace_id" SET NOT NULL;
  ALTER TABLE "form_submissions" ALTER COLUMN "client_key_hash" SET NOT NULL;
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_status_updated_by_id_admins_id_fk" FOREIGN KEY ("status_updated_by_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "forms_purpose_idx" ON "forms" USING btree ("purpose");
  DO $$
  DECLARE
    contact_form_id integer;
    contact_signature text;
    feedback_form_id integer;
    feedback_signature text;
    request_form_id integer;
    request_signature text;
    select_option_signature text;
  BEGIN
    INSERT INTO "forms" (
      "title", "submit_button_label", "confirmation_type", "purpose", "updated_at", "created_at"
    ) VALUES
      ('联系 Wanmi', '提交联系信息', 'message', 'contact', NOW(), NOW()),
      ('提交反馈', '提交反馈', 'message', 'feedback', NOW(), NOW()),
      ('提交需求', '提交需求', 'message', 'request', NOW(), NOW())
    ON CONFLICT ("purpose") DO NOTHING;

    SELECT "id" INTO contact_form_id FROM "forms" WHERE "purpose" = 'contact';
    SELECT "id" INTO feedback_form_id FROM "forms" WHERE "purpose" = 'feedback';
    SELECT "id" INTO request_form_id FROM "forms" WHERE "purpose" = 'request';

    IF NOT EXISTS (
      SELECT 1 FROM "forms_blocks_text" WHERE "_parent_id" = contact_form_id
      UNION ALL SELECT 1 FROM "forms_blocks_select" WHERE "_parent_id" = contact_form_id
      UNION ALL SELECT 1 FROM "forms_blocks_textarea" WHERE "_parent_id" = contact_form_id
    ) THEN
      INSERT INTO "forms_blocks_text" (
        "_order", "_parent_id", "_path", "id", "name", "label", "required"
      ) VALUES
        (0, contact_form_id, 'fields', 'd3-contact-name', 'name', '姓名或称呼', false),
        (1, contact_form_id, 'fields', 'd3-contact-contact', 'contact', '联系方式', true);
      INSERT INTO "forms_blocks_select" (
        "_order", "_parent_id", "_path", "id", "name", "label", "required"
      ) VALUES (2, contact_form_id, 'fields', 'd3-contact-topic', 'topic', '联系主题', true);
      INSERT INTO "forms_blocks_select_options" (
        "_order", "_parent_id", "id", "label", "value"
      ) VALUES
        (0, 'd3-contact-topic', 'd3-contact-topic-general', '一般咨询', 'general'),
        (1, 'd3-contact-topic', 'd3-contact-topic-content', '内容合作', 'content'),
        (2, 'd3-contact-topic', 'd3-contact-topic-advertising', '广告合作', 'advertising'),
        (3, 'd3-contact-topic', 'd3-contact-topic-other', '其他事项', 'other');
      INSERT INTO "forms_blocks_textarea" (
        "_order", "_parent_id", "_path", "id", "name", "label", "required"
      ) VALUES (3, contact_form_id, 'fields', 'd3-contact-message', 'message', '具体内容', true);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM "forms_blocks_text" WHERE "_parent_id" = feedback_form_id
      UNION ALL SELECT 1 FROM "forms_blocks_select" WHERE "_parent_id" = feedback_form_id
      UNION ALL SELECT 1 FROM "forms_blocks_textarea" WHERE "_parent_id" = feedback_form_id
    ) THEN
      INSERT INTO "forms_blocks_text" (
        "_order", "_parent_id", "_path", "id", "name", "label", "required"
      ) VALUES
        (0, feedback_form_id, 'fields', 'd3-feedback-contact', 'contact', '联系方式（选填）', false),
        (3, feedback_form_id, 'fields', 'd3-feedback-page-path', 'pagePath', '相关页面路径（选填）', false),
        (4, feedback_form_id, 'fields', 'd3-feedback-request-id', 'requestId', '请求 ID（选填）', false);
      INSERT INTO "forms_blocks_select" (
        "_order", "_parent_id", "_path", "id", "name", "label", "required"
      ) VALUES
        (1, feedback_form_id, 'fields', 'd3-feedback-type', 'feedbackType', '反馈类型', true),
        (2, feedback_form_id, 'fields', 'd3-feedback-tool', 'tool', '相关工具（选填）', false);
      INSERT INTO "forms_blocks_select_options" (
        "_order", "_parent_id", "id", "label", "value"
      ) VALUES
        (0, 'd3-feedback-type', 'd3-feedback-type-tool-error', '工具结果问题', 'tool_error'),
        (1, 'd3-feedback-type', 'd3-feedback-type-content-issue', '内容问题', 'content_issue'),
        (2, 'd3-feedback-type', 'd3-feedback-type-suggestion', '体验建议', 'suggestion'),
        (3, 'd3-feedback-type', 'd3-feedback-type-other', '其他反馈', 'other'),
        (0, 'd3-feedback-tool', 'd3-feedback-tool-domain-search', '域名可注册查询', 'domain-search'),
        (1, 'd3-feedback-tool', 'd3-feedback-tool-whois', 'WHOIS / RDAP', 'whois'),
        (2, 'd3-feedback-tool', 'd3-feedback-tool-dns', 'DNS 查询', 'dns'),
        (3, 'd3-feedback-tool', 'd3-feedback-tool-ssl-check', 'SSL / CAA 检查', 'ssl-check'),
        (4, 'd3-feedback-tool', 'd3-feedback-tool-idn', 'IDN 转换', 'idn'),
        (5, 'd3-feedback-tool', 'd3-feedback-tool-pricing', 'TLD 价格', 'pricing');
      INSERT INTO "forms_blocks_textarea" (
        "_order", "_parent_id", "_path", "id", "name", "label", "required"
      ) VALUES (5, feedback_form_id, 'fields', 'd3-feedback-message', 'message', '反馈内容', true);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM "forms_blocks_text" WHERE "_parent_id" = request_form_id
      UNION ALL SELECT 1 FROM "forms_blocks_select" WHERE "_parent_id" = request_form_id
      UNION ALL SELECT 1 FROM "forms_blocks_textarea" WHERE "_parent_id" = request_form_id
      UNION ALL SELECT 1 FROM "forms_blocks_checkbox" WHERE "_parent_id" = request_form_id
    ) THEN
      INSERT INTO "forms_blocks_text" (
        "_order", "_parent_id", "_path", "id", "name", "label", "required"
      ) VALUES (0, request_form_id, 'fields', 'd3-request-contact', 'contact', '联系方式', true);
      INSERT INTO "forms_blocks_select" (
        "_order", "_parent_id", "_path", "id", "name", "label", "required"
      ) VALUES (1, request_form_id, 'fields', 'd3-request-type', 'requestType', '需求类型', true);
      INSERT INTO "forms_blocks_select_options" (
        "_order", "_parent_id", "id", "label", "value"
      ) VALUES
        (0, 'd3-request-type', 'd3-request-type-tool-feature', '新工具能力', 'tool_feature'),
        (1, 'd3-request-type', 'd3-request-type-tld-pricing', 'TLD 或价格信息', 'tld_pricing'),
        (2, 'd3-request-type', 'd3-request-type-content-topic', '内容选题', 'content_topic'),
        (3, 'd3-request-type', 'd3-request-type-business', '商务合作', 'business'),
        (4, 'd3-request-type', 'd3-request-type-other', '其他需求', 'other');
      INSERT INTO "forms_blocks_textarea" (
        "_order", "_parent_id", "_path", "id", "name", "label", "required"
      ) VALUES (2, request_form_id, 'fields', 'd3-request-message', 'message', '需求说明', true);
      INSERT INTO "forms_blocks_checkbox" (
        "_order", "_parent_id", "_path", "id", "name", "label", "required", "default_value"
      ) VALUES (
        3, request_form_id, 'fields', 'd3-request-consent', 'consent',
        '我同意 Wanmi 使用上述联系方式回复本次需求', true, false
      );
    END IF;

    WITH managed_fields AS (
      SELECT "_parent_id" AS form_id, "name", 'checkbox' AS field_type, "required"
      FROM "forms_blocks_checkbox"
      UNION ALL SELECT "_parent_id", "name", 'email', "required" FROM "forms_blocks_email"
      UNION ALL SELECT "_parent_id", COALESCE("block_name", '__message__'), 'message', false FROM "forms_blocks_message"
      UNION ALL SELECT "_parent_id", "name", 'number', "required" FROM "forms_blocks_number"
      UNION ALL SELECT "_parent_id", "name", 'select', "required" FROM "forms_blocks_select"
      UNION ALL SELECT "_parent_id", "name", 'text', "required" FROM "forms_blocks_text"
      UNION ALL SELECT "_parent_id", "name", 'textarea', "required" FROM "forms_blocks_textarea"
    )
    SELECT string_agg("name" || ':' || field_type || ':' || "required"::text, ',' ORDER BY "name")
    INTO contact_signature FROM managed_fields WHERE form_id = contact_form_id;

    WITH managed_fields AS (
      SELECT "_parent_id" AS form_id, "name", 'checkbox' AS field_type, "required"
      FROM "forms_blocks_checkbox"
      UNION ALL SELECT "_parent_id", "name", 'email', "required" FROM "forms_blocks_email"
      UNION ALL SELECT "_parent_id", COALESCE("block_name", '__message__'), 'message', false FROM "forms_blocks_message"
      UNION ALL SELECT "_parent_id", "name", 'number', "required" FROM "forms_blocks_number"
      UNION ALL SELECT "_parent_id", "name", 'select', "required" FROM "forms_blocks_select"
      UNION ALL SELECT "_parent_id", "name", 'text', "required" FROM "forms_blocks_text"
      UNION ALL SELECT "_parent_id", "name", 'textarea', "required" FROM "forms_blocks_textarea"
    )
    SELECT string_agg("name" || ':' || field_type || ':' || "required"::text, ',' ORDER BY "name")
    INTO feedback_signature FROM managed_fields WHERE form_id = feedback_form_id;

    WITH managed_fields AS (
      SELECT "_parent_id" AS form_id, "name", 'checkbox' AS field_type, "required"
      FROM "forms_blocks_checkbox"
      UNION ALL SELECT "_parent_id", "name", 'email', "required" FROM "forms_blocks_email"
      UNION ALL SELECT "_parent_id", COALESCE("block_name", '__message__'), 'message', false FROM "forms_blocks_message"
      UNION ALL SELECT "_parent_id", "name", 'number', "required" FROM "forms_blocks_number"
      UNION ALL SELECT "_parent_id", "name", 'select', "required" FROM "forms_blocks_select"
      UNION ALL SELECT "_parent_id", "name", 'text', "required" FROM "forms_blocks_text"
      UNION ALL SELECT "_parent_id", "name", 'textarea', "required" FROM "forms_blocks_textarea"
    )
    SELECT string_agg("name" || ':' || field_type || ':' || "required"::text, ',' ORDER BY "name")
    INTO request_signature FROM managed_fields WHERE form_id = request_form_id;

    SELECT string_agg(form_record."purpose"::text || ':' || select_field."name" || ':' || option."value", ','
                      ORDER BY form_record."purpose"::text, select_field."name", option."_order")
    INTO select_option_signature
    FROM "forms_blocks_select_options" option
    JOIN "forms_blocks_select" select_field ON select_field."id" = option."_parent_id"
    JOIN "forms" form_record ON form_record."id" = select_field."_parent_id"
    WHERE form_record."purpose" IN ('contact', 'feedback', 'request');

    IF contact_signature <> 'contact:text:true,message:textarea:true,name:text:false,topic:select:true'
      OR feedback_signature <> 'contact:text:false,feedbackType:select:true,message:textarea:true,pagePath:text:false,requestId:text:false,tool:select:false'
      OR request_signature <> 'consent:checkbox:true,contact:text:true,message:textarea:true,requestType:select:true'
      OR select_option_signature <> 'contact:topic:general,contact:topic:content,contact:topic:advertising,contact:topic:other,feedback:feedbackType:tool_error,feedback:feedbackType:content_issue,feedback:feedbackType:suggestion,feedback:feedbackType:other,feedback:tool:domain-search,feedback:tool:whois,feedback:tool:dns,feedback:tool:ssl-check,feedback:tool:idn,feedback:tool:pricing,request:requestType:tool_feature,request:requestType:tld_pricing,request:requestType:content_topic,request:requestType:business,request:requestType:other'
      OR EXISTS (
        SELECT 1 FROM "forms" form_record
        WHERE form_record."purpose" IN ('contact', 'feedback', 'request')
          AND (form_record."confirmation_type" IS DISTINCT FROM 'message' OR form_record."redirect_url" IS NOT NULL)
      )
      OR EXISTS (
        SELECT 1 FROM "forms_emails" email
        WHERE email."_parent_id" IN (contact_form_id, feedback_form_id, request_form_id)
      )
    THEN
      RAISE EXCEPTION 'D3-05 managed forms do not match the approved field matrix';
    END IF;
  END $$;
  CREATE INDEX "form_submissions_purpose_idx" ON "form_submissions" USING btree ("purpose");
  CREATE INDEX "form_submissions_status_idx" ON "form_submissions" USING btree ("status");
  CREATE INDEX "form_submissions_trace_id_idx" ON "form_submissions" USING btree ("trace_id");
  CREATE INDEX "form_submissions_client_key_hash_idx" ON "form_submissions" USING btree ("client_key_hash");
  CREATE INDEX "form_submissions_status_updated_by_idx" ON "form_submissions" USING btree ("status_updated_by_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "form_submissions" DROP CONSTRAINT "form_submissions_status_updated_by_id_admins_id_fk";
  
  DROP INDEX "forms_purpose_idx";
  DROP INDEX "form_submissions_purpose_idx";
  DROP INDEX "form_submissions_status_idx";
  DROP INDEX "form_submissions_trace_id_idx";
  DROP INDEX "form_submissions_client_key_hash_idx";
  DROP INDEX "form_submissions_status_updated_by_idx";
  ALTER TABLE "form_submissions" DROP COLUMN "purpose";
  ALTER TABLE "form_submissions" DROP COLUMN "summary";
  ALTER TABLE "form_submissions" DROP COLUMN "contact_masked";
  ALTER TABLE "form_submissions" DROP COLUMN "page_path";
  ALTER TABLE "form_submissions" DROP COLUMN "tool";
  ALTER TABLE "form_submissions" DROP COLUMN "request_id";
  ALTER TABLE "form_submissions" DROP COLUMN "status";
  ALTER TABLE "form_submissions" DROP COLUMN "trace_id";
  ALTER TABLE "form_submissions" DROP COLUMN "client_key_hash";
  ALTER TABLE "form_submissions" DROP COLUMN "status_updated_at";
  ALTER TABLE "form_submissions" DROP COLUMN "status_updated_by_id";
  DROP TYPE "public"."enum_form_submissions_purpose";
  DROP TYPE "public"."enum_form_submissions_tool";
  DROP TYPE "public"."enum_form_submissions_status";`)
}
