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
import { AnalyticsQuery } from './dto/analytics-query.dto';
import { CreateBlockDto } from './dto/create-block.dto';
import { ListSlotsQuery } from './dto/list-slots-query.dto';
import { ListAppointmentsQuery } from './dto/list-appointments-query.dto';
import { SetSlotDurationDto } from './dto/set-slot-duration.dto';
import { UpdateBlockDto } from './dto/update-block.dto';
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

  @Get(':id/schedule')
  @Roles('patient', 'doctor')
  @ApiOperation({ summary: 'View any doctor weekly schedule' })
  @ApiResponse({ status: 200, description: 'Weekly schedule of the doctor' })
  @ApiResponse({ status: 404, description: 'Doctor not found' })
  doctorSchedule(@Param('id', ParseIntPipe) id: number) {
    return this.doctors.getScheduleForDoctor(id);
  }

  @Get('me')
  @ApiOperation({ summary: "Get the current doctor's profile and slot duration" })
  @ApiResponse({ status: 200, description: 'Doctor profile' })
  getProfile(@CurrentUser() user: JwtPayload) {
    return this.doctors.getProfile(user.sub);
  }

  @Get('me/appointments')
  @ApiOperation({ summary: "List the current doctor's booked appointments" })
  @ApiResponse({ status: 200, description: 'Array of appointments with the patient name' })
  appointments(@Query() query: ListAppointmentsQuery, @CurrentUser() user: JwtPayload) {
    return this.doctors.listAppointments(user.sub, query.from, query.to);
  }

  @Get('me/analytics')
  @ApiOperation({ summary: 'Monthly analytics for the current doctor (pure SQL aggregation)' })
  @ApiResponse({ status: 200, description: 'Monthly metrics' })
  @ApiResponse({ status: 404, description: 'Doctor not found' })
  analytics(@Query() query: AnalyticsQuery, @CurrentUser() user: JwtPayload) {
    return this.doctors.getAnalytics(user.sub, query.month);
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

  @Get('me/blocks')
  @ApiOperation({ summary: 'List blocked dates/time ranges for the current doctor' })
  @ApiResponse({ status: 200, description: 'Array of blocked slots' })
  listBlocks(@CurrentUser() user: JwtPayload) {
    return this.doctors.listBlocks(user.sub);
  }

  @Get('me/blocks/:blockId')
  @ApiOperation({ summary: 'Get a single blocked date/time range' })
  @ApiResponse({ status: 200, description: 'Blocked slot' })
  @ApiResponse({ status: 404, description: 'Block not found' })
  getBlock(@Param('blockId', ParseIntPipe) blockId: number, @CurrentUser() user: JwtPayload) {
    return this.doctors.getBlock(user.sub, blockId);
  }

  @Patch('me/blocks/:blockId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a blocked date and/or time range' })
  @ApiResponse({ status: 200, description: 'Block updated' })
  @ApiResponse({ status: 404, description: 'Block not found' })
  updateBlock(
    @Param('blockId', ParseIntPipe) blockId: number,
    @Body() dto: UpdateBlockDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.doctors.updateBlock(user.sub, blockId, dto);
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