// Never expose provider response text, image data or credentials to clients/logs.
export function engineScanFailure(error) {
  const message=String(error?.message||'');
  if(message==='AI quota exhausted')return {error:'scan_provider_busy',status:503,retryAfter:30};
  if(error?.name==='TimeoutError'||error?.name==='AbortError')return {error:'scan_timeout',status:504};
  if(message==='AI is not configured')return {error:'scan_not_configured',status:503};
  return {error:'scan_upstream',status:502};
}
