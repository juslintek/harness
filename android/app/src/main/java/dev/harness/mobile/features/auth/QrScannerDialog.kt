package dev.harness.mobile.features.auth

import android.content.Context
import android.net.Uri
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.BasicAlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import dev.harness.mobile.theme.SecondaryLinkButton
import dev.harness.mobile.theme.StudioNorthTheme
import java.util.concurrent.Executors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QrScannerDialog(
    onScanned: (origin: String, code: String) -> Unit,
    onDismiss: () -> Unit
) {
    val colors = StudioNorthTheme.colors
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    BasicAlertDialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                .background(colors.surface)
                .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = "Scan Instance QR Code",
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                color = colors.ink
            )
            Spacer(modifier = Modifier.height(12.dp))

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(280.dp)
                    .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                    .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
            ) {
                AndroidView(
                    modifier = Modifier.matchParentSize(),
                    factory = { ctx ->
                        val previewView = PreviewView(ctx)
                        val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)
                        val executor = Executors.newSingleThreadExecutor()

                        cameraProviderFuture.addListener({
                            val cameraProvider = cameraProviderFuture.get()
                            val preview = Preview.Builder().build().also {
                                it.setSurfaceProvider(previewView.surfaceProvider)
                            }

                            val analyzer = ImageAnalysis.Builder()
                                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                .build()

                            analyzer.setAnalyzer(executor, QrCodeAnalyzer { text ->
                                val (origin, code) = parseHarnessUri(text)
                                if (code.isNotBlank()) {
                                    cameraProvider.unbindAll()
                                    ContextCompat.getMainExecutor(ctx).execute {
                                        onScanned(origin, code)
                                    }
                                }
                            })

                            try {
                                cameraProvider.unbindAll()
                                cameraProvider.bindToLifecycle(
                                    lifecycleOwner,
                                    CameraSelector.DEFAULT_BACK_CAMERA,
                                    preview,
                                    analyzer
                                )
                            } catch (_: Exception) {
                            }
                        }, ContextCompat.getMainExecutor(ctx))

                        previewView
                    }
                )
            }

            Spacer(modifier = Modifier.height(16.dp))
            SecondaryLinkButton(
                text = "Cancel",
                onClick = onDismiss
            )
        }
    }
}

fun parseHarnessUri(scannedText: String): Pair<String, String> {
    return try {
        val uri = Uri.parse(scannedText.trim())
        if (uri.scheme == "harness" && uri.host == "pair") {
            val origin = uri.getQueryParameter("origin") ?: "http://127.0.0.1:4100"
            val code = uri.getQueryParameter("code") ?: ""
            origin to code
        } else {
            "" to scannedText.trim()
        }
    } catch (_: Exception) {
        "" to scannedText.trim()
    }
}

private class QrCodeAnalyzer(
    private val onQrDetected: (String) -> Unit
) : ImageAnalysis.Analyzer {
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)))
    }

    override fun analyze(image: ImageProxy) {
        val buffer = image.planes[0].buffer
        val data = ByteArray(buffer.remaining())
        buffer.get(data)

        val source = PlanarYUVLuminanceSource(
            data,
            image.width,
            image.height,
            0,
            0,
            image.width,
            image.height,
            false
        )
        val bitmap = BinaryBitmap(HybridBinarizer(source))

        try {
            val result = reader.decodeWithState(bitmap)
            onQrDetected(result.text)
        } catch (_: Exception) {
        } finally {
            reader.reset()
            image.close()
        }
    }
}
