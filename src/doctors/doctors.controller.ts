import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.decorator';
import { DoctorsService } from './doctors.service';
import { CreateBlockDto } from './dto/create-block.dto';
import { ListSlotsQuery } from './dto/list-slots-query.dto';
import { SetSlotDurationDto } from './dto/set-slot-duration.dto';
import { UpsertScheduleDto } from './dto/upsert-schedule.dto';

@ApiTags('doctors')
@ApiBearerAuth()
@Controller('doctors')
@Roles('doctor')
export class DoctorsController {
  constructor(private readonly doctors: DoctorsService) {}

  @Get()
  @Roles('patient', 'doctor')
  @ApiOperation({ summary: 'List doctors' })
  @ApiResponse({ status: 200, description: 'Array of doctors' })
  list() {
    return this.doctors.listDoctors();
  }

  @Get(':id/slots')
  @Roles('patient', 'doctor')
  @ApiOperation({ summary: 'List available appointment slots for a doctor' })
  @ApiResponse({ status: 200, description: 'Array of available slots' })
  @ApiResponse({ status: 404, description: 'Doctor not found' })
  slots(@Param('id', ParseIntPipe) id: number, @Query() query: ListSlotsQuery) {
    return this.doctors.getAvailableSlots(id, query.from, query.to);
  }

  @Get('me/schedule')
  @ApiOperation({ summary: "Get the current doctor's weekly schedule" })
  getSchedule(@CurrentUser() user: JwtPayload) {
    return this.doctors.getSchedule(user.sub);
  }

  @Put('me/schedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Replace the current doctor's weekly schedule" })
  @ApiResponse({ status: 200, description: 'Schedule updated' })
  replaceSchedule(@Body() dto: UpsertScheduleDto, @CurrentUser() user: JwtPayload) {
    return this.doctors.replaceSchedule(user.sub, dto.entries);
  }

  @Post('me/blocks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Block a date or time range for the current doctor' })
  @ApiResponse({ status: 201, description: 'Block created' })
  addBlock(@Body() dto: CreateBlockDto, @CurrentUser() user: JwtPayload) {
    return this.doctors.addBlock(user.sub, dto);
  }

  @Delete('me/blocks/:blockId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a blocked date/time range' })
  @ApiResponse({ status: 200, description: 'Block removed' })
  @ApiResponse({ status: 404, description: 'Block not found' })
  removeBlock(@Param('blockId', ParseIntPipe) blockId: number, @CurrentUser() user: JwtPayload) {
    return this.doctors.removeBlock(user.sub, blockId);
  }

  @Patch('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set the current doctor slot duration (15, 30 or 60 minutes)' })
  @ApiResponse({ status: 200, description: 'Slot duration updated' })
  setSlotDuration(@Body() dto: SetSlotDurationDto, @CurrentUser() user: JwtPayload) {
    return this.doctors.setSlotDuration(user.sub, dto.slotDurationMin);
  }
}