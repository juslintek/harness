import {
  claimEnrollment,
  completeEnrollment,
  createEnrollment,
  enrollmentUser,
  firstRunEnrollment,
  newRecoveryCodes,
  redeemEnrollment,
  releaseEnrollment,
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
  stepUpRequired,
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
  onSessionRevoked,
  revokeSession,
  sessionExpiresAt,
  sessionFromToken,
} from "./sessions";
import { countUsers, createUser, findUserByEmail, getUser } from "./users";

export type { AuthEnv } from "./middleware";
export type { Rp } from "./passkeys";
export type { Session, SessionInfo } from "./sessions";
export type { User } from "./users";
export {
  claimEnrollment,
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
  onSessionRevoked,
  originGuard,
  redeemEnrollment,
  registrationOptions,
  releaseEnrollment,
  requestEmailCode,
  requireInstanceAdmin,
  requireStepUp,
  revokeSession,
  sessionExpiresAt,
  sessionFromToken,
  sessionMiddleware,
  stepUpOptions,
  stepUpRequired,
  useRecoveryCode,
  verifyEmailCode,
};
