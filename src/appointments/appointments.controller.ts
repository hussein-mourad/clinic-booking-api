import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.decorator';
import { AppointmentsService } from './appointments.service';
import { BookDto } from './dto/book.dto';
import { MineQuery } from './dto/mine-query.dto';

@ApiTags('appointments')
@ApiBearerAuth()
@Controller('appointments')
@Roles('patient')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Post()
  @ApiOperation({ summary: 'Book an appointment slot' })
  @ApiResponse({ status: 201, description: 'Appointment created' })
  @ApiResponse({ status: 400, description: 'Slot is not available' })
  @ApiResponse({ status: 404, description: 'Doctor not found' })
  @ApiResponse({ status: 409, description: 'Slot already taken' })
  book(@CurrentUser() user: JwtPayload, @Body() body: BookDto) {
    return this.appointments.book(user.sub, body);
  }

  @Get('me')
  @ApiOperation({ summary: "List the current patient's appointments, optionally filtered by status" })
  @ApiResponse({ status: 200, description: 'Array of appointments' })
  mine(@CurrentUser() user: JwtPayload, @Query() query: MineQuery) {
    return this.appointments.mine(user.sub, query.status);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a booking (must be at least 2h before start)' })
  @ApiResponse({ status: 200, description: 'Appointment cancelled' })
  @ApiResponse({ status: 404, description: 'Appointment not found' })
  @ApiResponse({ status: 409, description: 'Appointment is no longer active' })
  @ApiResponse({ status: 422, description: 'Within the 2h cancellation window' })
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtPayload) {
    return this.appointments.cancel(user.sub, id);
  }
}