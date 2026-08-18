export type UnsafeUrlCode =
  | 'private'
  | 'protocol'
  | 'credentials'
  | 'port'
  | 'too_large'
  | 'timeout'
  | 'content_type'
  | 'redirect'
  | 'unresolved';

export const URL_GUARD_MESSAGES: Record<UnsafeUrlCode, string> = {
  private: 'This URL is on a private network and cannot be imported',
  protocol: 'Only http and https URLs are allowed',
  credentials: 'URLs must not include login details',
  port: 'Only standard web ports (80/443) are allowed',
  too_large: 'This page is too large (over 10 MB)',
  timeout: 'The website did not respond',
  content_type: 'This page type cannot be imported',
  redirect: 'The website followed too many redirects',
  unresolved: 'This website could not be resolved',
};
