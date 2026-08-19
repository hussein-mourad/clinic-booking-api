import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'patient@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'secret123' })
  @IsString()
  password: string;
}
