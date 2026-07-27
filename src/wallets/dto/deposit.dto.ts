import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class DepositDto {
  @ApiProperty({ example: 100 })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiPropertyOptional({ description: 'Client supplied idempotency key' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  reference?: string;
}
