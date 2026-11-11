param(
  [Parameter(Mandatory = $true)][string]$Png
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Bitmap]::FromFile($Png)
$w=$img.Width; $h=$img.Height
# scan bottom 340 rows, right 40% of screen, avoid green caret / bubbles
$pts = New-Object System.Collections.ArrayList
for($y=$h-340; $y -lt $h; $y+=2){
  for($x=[int]($w*0.6); $x -lt $w; $x+=2){
    $c=$img.GetPixel($x,$y)
    if($c.R -lt 90 -and $c.G -gt 150 -and $c.B -lt 140 -and $c.G -gt ($c.R+60)){
      [void]$pts.Add(@($x,$y))
    }
  }
}
$img.Dispose()

if ($pts.Count -eq 0) {
  "NOT_FOUND"
  "CENTER: 0,0"
  exit 0
}

# send button is the rightmost green blob; a thin green caret (a few px wide)
# would poison a plain bbox, so take the rightmost point and keep 160px left of it.
$maxX = ($pts | ForEach-Object { $_[0] } | Measure-Object -Maximum).Maximum
$keep = $pts | Where-Object { $_[0] -ge ($maxX - 160) }
$minX = ($keep | ForEach-Object { $_[0] } | Measure-Object -Minimum).Minimum
$minY = ($keep | ForEach-Object { $_[1] } | Measure-Object -Minimum).Minimum
$maxY = ($keep | ForEach-Object { $_[1] } | Measure-Object -Maximum).Maximum
if (($maxX - $minX) -lt 50) {
  # too narrow, probably only the caret / an icon, not the send button
  "NOT_FOUND"
  "CENTER: 0,0"
} else {
  $cx=[int](($minX+$maxX)/2); $cy=[int](($minY+$maxY)/2)
  "BBOX: $minX,$minY - $maxX,$maxY"
  "CENTER: $cx,$cy"
}
