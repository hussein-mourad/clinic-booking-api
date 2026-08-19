import { pgEnum } from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['patient', 'doctor']);

export const appointmentStatusEnum = pgEnum('appointment_status', [
  'scheduled',
  'cancelled',
  'completed',
]);

export const waitlistStatusEnum = pgEnum('waitlist_status', [
  'waiting',
  'offered',
  'accepted',
  'expired',
  'declined',
]);

export const notificationTypeEnum = pgEnum('notification_type', [
  'reminder',
  'waitlist_offer',
  'waitlist_confirmation',
]);
