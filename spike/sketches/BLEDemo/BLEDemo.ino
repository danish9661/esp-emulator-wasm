#include <NimBLEDevice.h>

static NimBLEServer*      pServer;
static NimBLECharacteristic* pChar;
static uint32_t           gNotifyCounter = 0;
static uint32_t           gLoopCount     = 0;
static uint32_t           gConnCount     = 0;

// ---- Server callbacks: connection lifecycle ----
class MyServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) override {
        gConnCount++;
        Serial.printf("[BLE] connect peer=%s handle=%d\n",
                      connInfo.getAddress().toString().c_str(),
                      connInfo.getConnHandle());
    }
    void onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) override {
        Serial.printf("[BLE] disconnect peer=%s reason=0x%02x\n",
                      connInfo.getAddress().toString().c_str(), reason);
        if (gConnCount > 0) gConnCount--;
        // Restart advertising so the next peer can find us again.
        NimBLEDevice::startAdvertising();
    }
    void onMTUChange(uint16_t MTU, NimBLEConnInfo& connInfo) override {
        Serial.printf("[BLE] mtu-change peer=%s mtu=%d\n",
                      connInfo.getAddress().toString().c_str(), MTU);
    }
};

// ---- Characteristic callbacks: GATT read/write/notify ----
class MyCharCallbacks : public NimBLECharacteristicCallbacks {
    void onRead(NimBLECharacteristic* pCharacteristic, NimBLEConnInfo& connInfo) override {
        Serial.printf("[BLE] gatt-read peer=%s uuid=%s\n",
                      connInfo.getAddress().toString().c_str(),
                      pCharacteristic->getUUID().toString().c_str());
    }
    void onWrite(NimBLECharacteristic* pCharacteristic, NimBLEConnInfo& connInfo) override {
        std::string v = pCharacteristic->getValue();
        Serial.printf("[BLE] gatt-write peer=%s uuid=%s len=%d: ",
                      connInfo.getAddress().toString().c_str(),
                      pCharacteristic->getUUID().toString().c_str(), (int)v.length());
        for (uint8_t b : v) Serial.printf("%02x ", b);
        Serial.printf("\n");
    }
    void onSubscribe(NimBLECharacteristic* pCharacteristic, NimBLEConnInfo& connInfo, uint16_t subValue) override {
        Serial.printf("[BLE] gatt-subscribe peer=%s uuid=%s sub=0x%04x\n",
                      connInfo.getAddress().toString().c_str(),
                      pCharacteristic->getUUID().toString().c_str(), subValue);
    }
};

void setup(void) {
    Serial.begin(115200);
    Serial.println("\n[BLE] starting");

    NimBLEDevice::init("NimBLE");
    Serial.println("[BLE] init done");

    uint64_t mac = ESP.getEfuseMac();
    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02x:%02x:%02x:%02x:%02x:%02x",
             (int)((mac >> 40) & 0xff), (int)((mac >> 32) & 0xff),
             (int)((mac >> 24) & 0xff), (int)((mac >> 16) & 0xff),
             (int)((mac >> 8) & 0xff),  (int)(mac & 0xff));
    Serial.printf("[BLE] local-mac=%s\n", macStr);

    pServer = NimBLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());
    Serial.println("[BLE] server created");

    NimBLEService* pService = pServer->createService("DEAD");
    pChar = pService->createCharacteristic(
        "BEEF", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
    pChar->setValue("Burger");
    pChar->setCallbacks(new MyCharCallbacks());
    Serial.printf("[BLE] service created uuid=%s\n",
                  pService->getUUID().toString().c_str());
    Serial.printf("[BLE] characteristic uuid=%s props=0x%02x value='%s'\n",
                  pChar->getUUID().toString().c_str(), pChar->getProperties(),
                  pChar->getValue().c_str());

    NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
    pAdvertising->setName("NimBLE-Server");
    pAdvertising->addServiceUUID(pService->getUUID());
    pAdvertising->enableScanResponse(true);
    pAdvertising->start();
    Serial.printf("[BLE] advertising started name='NimBLE-Server' scan-response=1\n");
    Serial.println("[BLE] ble-done");
}

void loop(void) {
    delay(100);
    gLoopCount++;
    // Periodic heartbeat so behavior is observable even without a peer.
    if (gLoopCount % 50 == 0) {
        uint32_t up = gLoopCount * 100;  // ms
        Serial.printf("[BLE] heartbeat uptime=%ums connections=%d\n",
                      up, (int)gConnCount);
        // Demonstrate a NOTIFY: bump the value and push it to subscribers.
        String s = "tick-" + String(gNotifyCounter++);
        pChar->setValue(s.c_str());
        pChar->notify();
        Serial.printf("[BLE] gatt-notify uuid=%s value='%s'\n",
                      pChar->getUUID().toString().c_str(), s.c_str());
    }
}
