import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1794857365168 implements MigrationInterface {
    name = 'InitialSchema1794857365168'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" text NOT NULL, "customer_id" text NOT NULL, "purpose" text NOT NULL, "method" text, "provider" text NOT NULL, "provider_payment_id" text, "amount_minor" bigint NOT NULL, "currency" text NOT NULL DEFAULT 'INR', "amount_refunded_minor" bigint NOT NULL DEFAULT '0', "status" text NOT NULL DEFAULT 'created', "last_error_code" text, "last_error_message" text, "attempt_count" integer NOT NULL DEFAULT '0', "collected_by_staff_id" text, "provider_data" jsonb, "order_sync_status" text NOT NULL DEFAULT 'none', "order_sync_attempts" integer NOT NULL DEFAULT '0', "next_retry_at" TIMESTAMP WITH TIME ZONE, "lease_owner" text, "lease_expires_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b2f7b823a21562eeca20e72b00" ON "payments" ("order_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payments_provider_ref" ON "payments" ("provider", "provider_payment_id") WHERE "provider_payment_id" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payments_live_per_order_purpose" ON "payments" ("order_id", "purpose") WHERE "status" <> 'canceled'`);
        await queryRunner.query(`CREATE TABLE "payment_attempts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "payment_id" uuid NOT NULL, "provider_attempt_ref" text, "status" text NOT NULL, "error_code" text, "decline_code" text, "message" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a0d8a67c07a0fef98dfd20214e5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7cfd4f071a14efe7a8c22f7407" ON "payment_attempts" ("payment_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payment_attempts_ref" ON "payment_attempts" ("payment_id", "provider_attempt_ref") WHERE "provider_attempt_ref" IS NOT NULL`);
        await queryRunner.query(`CREATE TABLE "payment_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "provider" text NOT NULL, "provider_event_id" text NOT NULL, "type" text NOT NULL, "payload" jsonb NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE, "error" text, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9f1d16fc78b33e676940a32e8b5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payment_events_provider_event" ON "payment_events" ("provider", "provider_event_id") `);
        await queryRunner.query(`CREATE TABLE "refunds" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "payment_id" uuid NOT NULL, "provider_refund_id" text, "amount_minor" bigint NOT NULL, "reason" text NOT NULL, "status" text NOT NULL DEFAULT 'pending', "failure_reason" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5106efb01eeda7e49a78b869738" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7f48aa5d56c42aeb495db01668" ON "refunds" ("payment_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_refunds_provider_ref" ON "refunds" ("provider_refund_id") WHERE "provider_refund_id" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."UQ_refunds_provider_ref"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7f48aa5d56c42aeb495db01668"`);
        await queryRunner.query(`DROP TABLE "refunds"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_payment_events_provider_event"`);
        await queryRunner.query(`DROP TABLE "payment_events"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_payment_attempts_ref"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7cfd4f071a14efe7a8c22f7407"`);
        await queryRunner.query(`DROP TABLE "payment_attempts"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_payments_live_per_order_purpose"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_payments_provider_ref"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b2f7b823a21562eeca20e72b00"`);
        await queryRunner.query(`DROP TABLE "payments"`);
    }

}
