import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Matches, Max, Min } from 'class-validator';

export const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class ScheduleEntryDto {
  @ApiProperty({ enum: [0, 1, 2, 3, 4, 5, 6], description: '0 = Sunday .. 6 = Saturday' })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @ApiProperty({ example: '10:00' })
  @Matches(TIME_REGEX, { message: 'startTime must be HH:MM' })
  startTime: string;

  @ApiProperty({ example: '16:00' })
  @Matches(TIME_REGEX, { message: 'endTime must be HH:MM' })
  endTime: string;
}