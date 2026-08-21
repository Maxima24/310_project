import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `POST /cameras/browser-sessions` body.
 *
 * Note what is NOT here: no `id`, no `type`, no `capabilities`, no `origin`. Those are
 * the fields that would let a caller name a browser feed after real hardware or mark it
 * as a device, so the hub decides all four.
 *
 * A client that sends them anyway loses them silently: the global ValidationPipe runs
 * with `whitelist: true` (see main.ts), which strips properties absent from this class
 * before the service ever sees the body. That is a guarantee of the pipe, not of this
 * comment — but it is worth stating, because "the DTO omits it" only prevents anything
 * if you know why.
 */
export class CreateBrowserCameraDto {
  @IsString()
  @IsNotEmpty({ message: 'Say where the camera is.' })
  @MaxLength(80)
  location: string;

  /** A note about whose browser this is. Displayed as given, never verified. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  label?: string;
}
