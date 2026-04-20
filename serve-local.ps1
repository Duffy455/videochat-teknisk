$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:8080/")
$listener.Start()

Write-Host "Serving $root at http://localhost:8080/"

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $path = $context.Request.Url.AbsolutePath.TrimStart("/")
    if ([string]::IsNullOrWhiteSpace($path)) {
      $path = "video-join.html"
    }

    $fullPath = Join-Path $root $path
    if ((Test-Path $fullPath) -and -not (Get-Item $fullPath).PSIsContainer) {
      $bytes = [System.IO.File]::ReadAllBytes($fullPath)
      $extension = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
      $contentType = switch ($extension) {
        ".html" { "text/html; charset=utf-8" }
        ".css" { "text/css; charset=utf-8" }
        ".js" { "text/javascript; charset=utf-8" }
        ".json" { "application/json; charset=utf-8" }
        default { "application/octet-stream" }
      }

      $context.Response.ContentType = $contentType
      $context.Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
      $context.Response.Headers["Pragma"] = "no-cache"
      $context.Response.Headers["Expires"] = "0"
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $context.Response.StatusCode = 404
    }

    $context.Response.Close()
  }
}
finally {
  $listener.Stop()
}
