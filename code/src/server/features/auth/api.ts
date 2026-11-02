import {
  completeEnrollment,
  createEnrollment,
  enrollmentUser,
  firstRunEnrollment,
  newRecoveryCodes,
  redeemEnrollment,
  requestEmailCode,
  useRecoveryCode,
  verifyEmailCode,
} from "./codes";
import {
  hostGuard,
  mutationOriginGuard,
  originGuard,
  requireInstanceAdmin,
  requireStepUp,
  sessionMiddleware,
} from "./middleware";
import {
  finishLogin,
  finishRegistration,
  finishStepUp,
  loginOptions,
  registrationOptions,
  stepUpOptions,
} from "./passkeys";
import {
  createSession,
  hasFreshStepUp,
  listSessions,
  revokeSession,
  sessionFromToken,
} from "./sessions";
import { countUsers, createUser, findUserByEmail, getUser } from "./users";

export type { AuthEnv } from "./middleware";
export type { Rp } from "./passkeys";
export type { Session, SessionInfo } from "./sessions";
export type { User } from "./users";
export {
  completeEnrollment,
  countUsers,
  createEnrollment,
  createSession,
  createUser,
  enrollmentUser,
  findUserByEmail,
  finishLogin,
  finishRegistration,
  finishStepUp,
  firstRunEnrollment,
  getUser,
  hasFreshStepUp,
  hostGuard,
  listSessions,
  loginOptions,
  mutationOriginGuard,
  newRecoveryCodes,
  originGuard,
  redeemEnrollment,
  registrationOptions,
  requestEmailCode,
  requireInstanceAdmin,
  requireStepUp,
  revokeSession,
  sessionFromToken,
  sessionMiddleware,
  stepUpOptions,
  useRecoveryCode,
  verifyEmailCode,
};
