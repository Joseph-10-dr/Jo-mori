import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export interface UserAuth {
  kind: 'user';
  userId: string;
  sessionId: string;
  email: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  mfaPassed: boolean;
}

export interface DeviceAuth {
  kind: 'device';
  deviceId: string;
  credentialId: string;
  ownerUserId: string;
  organizationId: string | null;
  platform: string;
}

export type AuthContext = UserAuth | DeviceAuth;

export interface AuthedRequest extends Request {
  auth?: AuthContext;
}

export const AUTH_MODE = 'tv:auth-mode';
/** public: no auth. device: device credential. user (default): session. mfa-pending: session before MFA step. */
export type AuthMode = 'public' | 'device' | 'user' | 'mfa-pending';
export const Public = () => SetMetadata(AUTH_MODE, 'public');
export const DeviceOnly = () => SetMetadata(AUTH_MODE, 'device');
export const AllowMfaPending = () => SetMetadata(AUTH_MODE, 'mfa-pending');

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): UserAuth => {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth || auth.kind !== 'user') throw new Error('CurrentUser used on non-user route');
  return auth;
});

export const CurrentDevice = createParamDecorator((_: unknown, ctx: ExecutionContext): DeviceAuth => {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth || auth.kind !== 'device') throw new Error('CurrentDevice used on non-device route');
  return auth;
});

export function clientIp(req: Request): string | null {
  return req.ip?.replace(/^::ffff:/, '') || null;
}

export const SESSION_COOKIE = 'tv_session';
export const CSRF_HEADER = 'x-tracevault-csrf';
