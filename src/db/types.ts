import type {
  appointments,
  blockedSlots,
  notifications,
  schedules,
  users,
  waitingList,
} from './schema';

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Schedule = typeof schedules.$inferSelect;
export type NewSchedule = typeof schedules.$inferInsert;

export type BlockedSlot = typeof blockedSlots.$inferSelect;
export type NewBlockedSlot = typeof blockedSlots.$inferInsert;

export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;

export type WaitingListEntry = typeof waitingList.$inferSelect;
export type NewWaitingListEntry = typeof waitingList.$inferInsert;

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
