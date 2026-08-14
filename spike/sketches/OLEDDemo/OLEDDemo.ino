#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

int ballX = 64;
int ballY = 32;
int speedX = 2;
int speedY = 1;
int frameCount = 0;

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n[OLED] Initializing I2C & SSD1306...");

  // ESP32-C3 default I2C pins: SDA=8, SCL=9
  Wire.begin(8, 9);

  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println("[OLED] SSD1306 allocation/init failed!");
    for (;;);
  }

  Serial.println("[OLED] Display initialized successfully!");

  // Splash screen
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.drawRect(0, 0, 128, 64, SSD1306_WHITE);
  display.drawRect(2, 2, 124, 60, SSD1306_WHITE);

  display.setCursor(16, 12);
  display.print("ESP32-C3 WASM");

  display.setCursor(20, 26);
  display.print("Virtual SSD1306");

  display.setCursor(12, 42);
  display.print("Adafruit_GFX Live");

  display.display();
  Serial.println("[OLED] Splash frame sent.");
  delay(1000);
}

void loop() {
  display.clearDisplay();

  // Draw header bar
  display.fillRect(0, 0, 128, 10, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK, SSD1306_WHITE);
  display.setCursor(4, 1);
  display.print("ESP-EMU OLED DEMO");

  // Draw status info
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(4, 16);
  display.printf("Frames: %d", frameCount++);

  display.setCursor(4, 28);
  display.printf("Ball: (%d, %d)", ballX, ballY);

  // Draw border & graphics
  display.drawRect(0, 12, 128, 52, SSD1306_WHITE);
  display.drawCircle(ballX, ballY, 4, SSD1306_WHITE);
  display.fillCircle(ballX, ballY, 2, SSD1306_WHITE);

  // Bounce physics
  ballX += speedX;
  ballY += speedY;
  if (ballX <= 6 || ballX >= 121) speedX = -speedX;
  if (ballY <= 18 || ballY >= 57) speedY = -speedY;

  display.display();
  delay(50);
}
