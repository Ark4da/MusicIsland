# Builds every icon from the user's sketch (source.jpg): large sizes are the sketch's tile cut out with a
# rounded mask (keeps its texture and glow); small sizes are redrawn as vectors with a thicker glyph.
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::FromFile("$PSScriptRoot\icon-source.jpg")
$app = $PSScriptRoot
$ext = Join-Path $PSScriptRoot '..\..\browser-extension\icons'
New-Item -ItemType Directory -Force $ext | Out-Null

# Tile in the sketch, measured: x 492..914, y 158..580.
$TILE = New-Object System.Drawing.Rectangle 492, 158, 422, 422
$RADIUS = 0.225

function RoundRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure(); return $p
}

function Downscale($big, [int]$size) {
  $out = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.CompositingQuality = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($big, (New-Object System.Drawing.Rectangle 0, 0, $size, $size))
  $g.Dispose(); return $out
}

# Large: the sketch's own tile, masked to a rounded square, inset by $pad px in a $size canvas.
function FromSketch([int]$size, [int]$pad = 0) {
  $k = 4; $S = $size * $k; $inner = ($size - 2 * $pad) * $k; $off = $pad * $k
  $big = New-Object System.Drawing.Bitmap $S, $S
  $g = [System.Drawing.Graphics]::FromImage($big)
  $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.Clear([System.Drawing.Color]::Transparent)
  $g.SetClip((RoundRect $off $off $inner $inner ($inner * $RADIUS)))
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle $off, $off, $inner, $inner), $TILE, 'Pixel')
  $g.Dispose(); $r = Downscale $big $size; $big.Dispose(); return $r
}

# Small: vector redraw. Bar spans are the sketch's, as fractions of the tile.
$BARS = @(@(0.507, 0.721), @(0.427, 0.756), @(0.168, 0.910), @(0.292, 0.803), @(0.372, 0.721))
function Vector([int]$size, [int]$pad = 0) {
  $k = 8; $S = $size * $k; $T = ($size - 2 * $pad) * $k; $o = $pad * $k
  $small = $size -le 32
  $big = New-Object System.Drawing.Bitmap $S, $S
  $g = [System.Drawing.Graphics]::FromImage($big)
  $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
  $tile = RoundRect $o $o $T $T ($T * $RADIUS)
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.PointF 0, $o), (New-Object System.Drawing.PointF 0, ($o + $T)), [System.Drawing.Color]::FromArgb(255, 44, 44, 46), [System.Drawing.Color]::FromArgb(255, 16, 16, 17))
  $g.FillPath($bg, $tile)
  # Pill: 80 % x 28 % of the tile in the sketch; wider and taller at tray sizes so it survives 16 px.
  $pw = if ($small) { 0.90 } else { 0.80 }; $ph = if ($small) { 0.40 } else { 0.284 }
  $px = $o + $T * (1 - $pw) / 2; $py = $o + $T * (0.431 + 0.142) - $T * $ph / 2
  $pill = RoundRect $px $py ($T * $pw) ($T * $ph) ($T * $ph / 2)
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 4, 4, 5))), $pill)
  $stroke = [math]::Max($T * 0.0095, 1.0 * $k)
  $g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 170, 170, 172)), $stroke), $pill)
  # Bars: 4.3 % wide on a 7.5 % pitch in the sketch; at tray sizes about twice as thick.
  $bw = if ($small) { 0.075 } else { 0.0427 }; $pitch = if ($small) { 0.135 } else { 0.0746 }
  $x0 = $o + $T * (0.5 - (2 * $pitch) - $bw / 2)
  for ($i = 0; $i -lt 5; $i++) {
    $top = $BARS[$i][0]; $bot = $BARS[$i][1]
    if ($small) { $mid = ($top + $bot) / 2; $half = ($bot - $top) / 2 * 1.08; $top = [math]::Max(0.10, $mid - $half); $bot = [math]::Min(0.90, $mid + $half) }
    $rect = New-Object System.Drawing.RectangleF ($x0 + $T * $pitch * $i), ($o + $T * $top), ($T * $bw), ($T * ($bot - $top))
    if (-not $small) {
      # Soft glow around each bar, as in the sketch.
      for ($gl = 3; $gl -ge 1; $gl--) {
        $grow = $T * 0.012 * $gl
        $glow = New-Object System.Drawing.RectangleF ($rect.X - $grow), ($rect.Y - $grow), ($rect.Width + 2 * $grow), ($rect.Height + 2 * $grow)
        $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(22, 255, 255, 255))), $glow)
      }
    }
    $bar = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 255, 255, 255), [System.Drawing.Color]::FromArgb(255, 200, 200, 204), [single]0)
    $g.FillRectangle($bar, $rect)
  }
  $g.Dispose(); $r = Downscale $big $size; $big.Dispose(); return $r
}

# Tray: the glyph alone on transparency, like the system's own tray icons. The pill spans almost the
# whole width; bar ends are the sketch's, measured in pill half-heights and compressed to fit the square.
# $ink is white for a dark taskbar and near-black for a light one.
function TrayGlyph([int]$size, [System.Drawing.Color]$ink) {
  $k = 8; $T = $size * $k
  $big = New-Object System.Drawing.Bitmap $T, $T
  $g = [System.Drawing.Graphics]::FromImage($big)
  $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
  $h = 0.23; $pw = 0.96; $c = 0.72
  $pill = RoundRect ($T * (1 - $pw) / 2) ($T * (0.5 - $h)) ($T * $pw) ($T * 2 * $h) ($T * $h)
  $outline = [System.Drawing.Color]::FromArgb(205, $ink.R, $ink.G, $ink.B)
  $g.DrawPath((New-Object System.Drawing.Pen ($outline, [math]::Max($T * 0.055, 1.0 * $k))), $pill)
  $bw = 0.085; $pitch = 0.15
  $x0 = $T * (0.5 - 2 * $pitch - $bw / 2)
  for ($i = 0; $i -lt 5; $i++) {
    $u1 = ($BARS[$i][0] - 0.573) / 0.142; $u2 = ($BARS[$i][1] - 0.573) / 0.142
    $top = 0.5 + $u1 * $h * $c; $bot = 0.5 + $u2 * $h * $c
    $rect = New-Object System.Drawing.RectangleF ($x0 + $T * $pitch * $i), ($T * $top), ($T * $bw), ($T * ($bot - $top))
    $g.FillRectangle((New-Object System.Drawing.SolidBrush $ink), $rect)
  }
  $g.Dispose(); $r = Downscale $big $size; $big.Dispose(); return $r
}

function Save($bmp, $path) { $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose() }

# App window / packaging icon and tray (tray.png + scale variants picked by nativeImage).
Save (FromSketch 256) "$app\icon.png"
$white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255); $black = [System.Drawing.Color]::FromArgb(255, 28, 28, 30)
foreach ($v in @(@(16, ''), @(20, '@1.25x'), @(24, '@1.5x'), @(32, '@2x'))) {
  Save (TrayGlyph $v[0] $white) "$app\tray$($v[1]).png"
  Save (TrayGlyph $v[0] $black) "$app\tray-light$($v[1]).png"
}

# Chrome extension: 128 keeps the store-style 8 px padding.
Save (FromSketch 128 8) "$ext\icon-128.png"; Save (Vector 48) "$ext\icon-48.png"; Save (Vector 32) "$ext\icon-32.png"; Save (Vector 16) "$ext\icon-16.png"

# Multi-size .ico (PNG entries) for Windows packaging.
$sizes = 16, 24, 32, 48, 64, 128, 256
$blobs = foreach ($s in $sizes) { $b = if ($s -ge 128) { FromSketch $s } else { Vector $s }; $ms = New-Object System.IO.MemoryStream; $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose(); , $ms.ToArray() }
$fs = [System.IO.File]::Create("$app\icon.ico"); $w = New-Object System.IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $blobs[$i].Length
  $w.Write([byte]($s % 256)); $w.Write([byte]($s % 256)); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$len); $w.Write([uint32]$offset); $offset += $len
}
foreach ($blob in $blobs) { $w.Write($blob) }
$w.Close()
'icons written'
