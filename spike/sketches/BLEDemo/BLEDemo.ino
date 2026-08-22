#include <NimBLEDevice.h>

static NimBLEServer* pServer;

void setup(void) {
    Serial.begin(115200);
    Serial.println("\n[BLE] starting");

    NimBLEDevice::init("NimBLE");
    Serial.println("[BLE] init done");

    pServer = NimBLEDevice::createServer();
    Serial.println("[BLE] server created");

    NimBLEService* pService = pServer->createService("DEAD");
    NimBLECharacteristic* pChar =
        pService->createCharacteristic("BEEF",
                                       NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
    pChar->setValue("Burger");
    Serial.println("[BLE] service created");

    NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
    pAdvertising->setName("NimBLE-Server");
    pAdvertising->addServiceUUID(pService->getUUID());
    pAdvertising->enableScanResponse(true);
    pAdvertising->start();
    Serial.println("[BLE] advertising started");
    Serial.println("[BLE] ble-done");
}

void loop(void) {
    delay(100);
}