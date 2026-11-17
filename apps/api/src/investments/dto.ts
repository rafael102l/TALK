import { Type } from "class-transformer";
import { IsNumber, Max, Min } from "class-validator";
import { MAX_INVEST_USD, MIN_INVEST_USD } from "./invest.constants";

export class CheckoutDto {
  @Type(() => Number)
  @IsNumber()
  @Min(MIN_INVEST_USD)
  @Max(MAX_INVEST_USD)
  amountUsd!: number;
}
