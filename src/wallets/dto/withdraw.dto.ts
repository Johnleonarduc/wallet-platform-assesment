import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class WithdrawDto {
  @ApiProperty({ example: 50 })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiPropertyOptional({ description: 'Client supplied idempotency key' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  reference?: string;
}
