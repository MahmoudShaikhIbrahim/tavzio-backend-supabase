-- Switch booking_otp_codes from a locally-generated code (Twilio) to
-- Message Central's Verify Now, which generates and validates the OTP
-- on its own side. We only ever hold the verificationId it returns.
alter table public.booking_otp_codes
  add column if not exists verification_id text,
  alter column code drop not null;
