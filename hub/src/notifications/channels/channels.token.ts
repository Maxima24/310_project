/**
 * Injection token for the channel list.
 *
 * A token rather than injecting each channel individually so adding Twilio or FCM is
 * one line in the provider array — the dispatcher iterates whatever it is given.
 */
export const ALERT_CHANNELS = 'ALERT_CHANNELS';
