import { UserRole } from './roles.decorator';

export interface JwtPayload {
  sub: number;
  email: string;
  role: UserRole;
}