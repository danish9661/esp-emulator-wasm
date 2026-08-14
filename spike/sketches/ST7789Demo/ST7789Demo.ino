#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <SPI.h>

#define TFT_CS   7
#define TFT_DC   2
#define TFT_RST  3

Adafruit_ST7789 tft = Adafruit_ST7789(&SPI, TFT_CS, TFT_DC, TFT_RST);

int ballX = 120, ballY = 120;
int vx = 3, vy = 2;
int frameCount = 0;

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n[TFT] Initializing ST7789 240x240 Color Display...");

  SPI.begin(4, 5, 6, 7); // SCK=4, MISO=5, MOSI=6, SS=7
  tft.init(240, 240);
  tft.setRotation(0);
  
  Serial.println("[TFT] ST7789 display initialized successfully!");

  // Splash screen
  tft.fillScreen(ST77XX_BLACK);

  tft.fillRect(0, 0, 240, 32, ST77XX_BLUE);
  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(2);
  tft.setCursor(14, 8);
  tft.println("ESP32-C3 WASM");

  tft.drawRect(5, 38, 230, 196, ST77XX_CYAN);
  tft.drawRect(7, 40, 226, 192, ST77XX_MAGENTA);

  tft.setTextColor(ST77XX_YELLOW);
  tft.setTextSize(2);
  tft.setCursor(20, 56);
  tft.println("Adafruit_ST7789");

  tft.setTextColor(ST77XX_GREEN);
  tft.setTextSize(1);
  tft.setCursor(20, 88);
  tft.println("240x240 16-bit RGB565 TFT");
  tft.setCursor(20, 106);
  tft.println("Hardware SPI Bridge (Phase 4)");

  // Color palette chips
  tft.fillRect(20, 130, 34, 34, ST77XX_RED);
  tft.fillRect(60, 130, 34, 34, ST77XX_GREEN);
  tft.fillRect(100, 130, 34, 34, ST77XX_BLUE);
  tft.fillRect(140, 130, 34, 34, ST77XX_YELLOW);
  tft.fillRect(180, 130, 34, 34, ST77XX_CYAN);

  Serial.println("[TFT] Color splash screen rendered.");
  delay(1000);
}

void loop() {
  // Clear ball area
  tft.fillCircle(ballX, ballY, 8, ST77XX_BLACK);
  
  ballX += vx;
  ballY += vy;
  if (ballX <= 16 || ballX >= 224) vx = -vx;
  if (ballY <= 48 || ballY >= 190) vy = -vy;

  tft.fillCircle(ballX, ballY, 8, ST77XX_CYAN);
  tft.fillCircle(ballX, ballY, 4, ST77XX_WHITE);

  tft.fillRect(20, 200, 200, 20, ST77XX_BLACK);
  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(1);
  tft.setCursor(20, 204);
  tft.printf("Frame: %d  Ball: (%d, %d)", frameCount++, ballX, ballY);

  delay(40);
}
