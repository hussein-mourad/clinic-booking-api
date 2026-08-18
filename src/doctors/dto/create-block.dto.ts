import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, Matches } from 'class-validator';
import { TIME_REGEX } from './schedule-entry.dto';

export class CreateBlockDto {
  @ApiProperty({ example: '2026-08-25', description: 'Blocked date (full day when no times given)' })
  @IsDateString()
  blockDate: string;

  @ApiPropertyOptional({ example: '12:00', description: 'Required together with endTime' })
  @IsOptional()
  @Matches(TIME_REGEX, { message: 'startTime must be HH:MM' })
  startTime?: string;

  @ApiPropertyOptional({ example: '14:00', description: 'Required together with startTime' })
  @IsOptional()
  @Matches(TIME_REGEX, { message: 'endTime must be HH:MM' })
  endTime?: string;
}