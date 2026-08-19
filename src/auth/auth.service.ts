import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { DRIZZLE } from '../db/database.module';
import type { Database } from '../db/database.module';
import { users } from '../db';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import type { JwtPayload } from './jwt-payload';

export interface AuthResult {
  token: string;
  user: {
    id: number;
    email: string;
    name: string;
    role: 'patient' | 'doctor';
  };
}

const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, dto.email))
      .limit(1);
    if (existing.length > 0)
      throw new ConflictException('Email is already registered');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const [user] = await this.db
      .insert(users)
      .values({
        email: dto.email,
        passwordHash,
        name: dto.name,
        role: dto.role ?? 'patient',
      })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
      });

    return {
      token: await this.sign(user),
      user,
    };
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, dto.email))
      .limit(1);

    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const view = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
    return { token: await this.sign(view), user: view };
  }

  private async sign(user: {
    id: number;
    email: string;
    role: 'patient' | 'doctor';
  }) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    return this.jwt.signAsync(payload);
  }
}
