import { relations } from 'drizzle-orm';
import { users } from './users';
import { schedules } from './schedules';
import { blockedSlots } from './blocks';
import { appointments } from './appointments';
import { waitingList } from './waiting-list';
import { notifications } from './notifications';

export const usersRelations = relations(users, ({ many }) => ({
  schedules: many(schedules),
  blocks: many(blockedSlots),
  appointmentsAsDoctor: many(appointments, { relationName: 'doctor' }),
  appointmentsAsPatient: many(appointments, { relationName: 'patient' }),
  waitingListAsPatient: many(waitingList, { relationName: 'patient' }),
  notifications: many(notifications),
}));

export const schedulesRelations = relations(schedules, ({ one }) => ({
  doctor: one(users, { fields: [schedules.doctorId], references: [users.id] }),
}));

export const blockedSlotsRelations = relations(blockedSlots, ({ one }) => ({
  doctor: one(users, {
    fields: [blockedSlots.doctorId],
    references: [users.id],
  }),
}));

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  doctor: one(users, {
    relationName: 'doctor',
    fields: [appointments.doctorId],
    references: [users.id],
  }),
  patient: one(users, {
    relationName: 'patient',
    fields: [appointments.patientId],
    references: [users.id],
  }),
}));

export const waitingListRelations = relations(waitingList, ({ one }) => ({
  doctor: one(users, {
    fields: [waitingList.doctorId],
    references: [users.id],
  }),
  patient: one(users, {
    relationName: 'patient',
    fields: [waitingList.patientId],
    references: [users.id],
  }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));
