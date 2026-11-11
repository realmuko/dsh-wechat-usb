param([string]$Png)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$img=[System.Drawing.Bitmap]::FromFile($Png)
$sb=New-Object System.Text.StringBuilder
for($y=150; $y -lt $img.Height; $y+=6){
  for($x=0; $x -lt $img.Width; $x+=6){
    $c=$img.GetPixel($x,$y)
    [void]$sb.Append($c.R).Append(',').Append($c.G).Append(',').Append($c.B).Append(';')
  }
}
$img.Dispose()
$md5=[System.Security.Cryptography.MD5]::Create()
$bytes=[System.Text.Encoding]::UTF8.GetBytes($sb.ToString())
[BitConverter]::ToString($md5.ComputeHash($bytes)).Replace('-','')
