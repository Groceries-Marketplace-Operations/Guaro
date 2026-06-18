import { Controller, Post } from '@nestjs/common';

@Controller('dev/error')
export class DevErrorController {
  @Post('test')
  test() {
    throw new Error('Test error from dev endpoint — GlobalErrorFilter check');
  }
}
