#include "radio_api.h"

#ifdef RADIOMODE

#include "board_io.h"
#include "cmsis_os2.h"
#include "FreeRTOS.h"
#include "task.h"

#include <stdio.h>
#include <string.h>

#define RF_BUFFER_CAPACITY          256U
#define RX_DATA_CAPACITY            (12U + RF_BUFFER_CAPACITY)
#define TX_WIRE_CAPACITY            (18U + RF_BUFFER_CAPACITY)
#define RX_BATCH_BYTES              64U
#define RX_BATCH_COUNT              8U

#define RX_FRAME_IDLE_MS            100U
#define COMMAND_FRAGMENT_IDLE_MS    500U
#define UART_TX_TIMEOUT_MS         1000U
#define AT_TIMEOUT_MS               500U
#define RF_STATUS_TIMEOUT_MS       3000U /* Tune with the configured RR and link. */
#define STARTUP_RETRY_MS           1000U
#define RSSI_INTERVAL_MS            100U
#define DIAGNOSTIC_INTERVAL_MS     5000U /* One read per interval, in rotation. */

enum {
    XBEE_START = 0x7E, XBEE_AT = 0x08, XBEE_TRANSMIT = 0x10,
    XBEE_AT_RESPONSE = 0x88, XBEE_MODEM_STATUS = 0x8A,
    XBEE_TRANSMIT_STATUS = 0x8B, XBEE_RECEIVE = 0x90
};

typedef enum {
    RX_START, RX_LENGTH_HIGH, RX_LENGTH_LOW, RX_DATA, RX_CHECKSUM
} RxState;

typedef enum {
    AT_DH, AT_DL, AT_NP, AT_DB, AT_EA, AT_ER, AT_TR, AT_VR
} AtCommand;

static const char at_names[][2] = {
    [AT_DH] = {'D', 'H'}, [AT_DL] = {'D', 'L'}, [AT_NP] = {'N', 'P'},
    [AT_DB] = {'D', 'B'}, [AT_EA] = {'E', 'A'}, [AT_ER] = {'E', 'R'},
    [AT_TR] = {'T', 'R'}, [AT_VR] = {'V', 'R'}
};
static const uint8_t at_value_limits[] = {
    [AT_DH] = 4U, [AT_DL] = 4U, [AT_NP] = 2U, [AT_DB] = 1U,
    [AT_EA] = 2U, [AT_ER] = 2U, [AT_TR] = 2U, [AT_VR] = 2U
};
static const AtCommand startup_commands[] = {AT_DH, AT_DL, AT_NP};
static const AtCommand diagnostic_commands[] = {AT_EA, AT_ER, AT_TR, AT_VR};

typedef struct {
    uint8_t id;
    uint32_t started;
} PendingRequest;

/* Only UARTParserTask reads or writes this state. */
static struct {
    bool (*on_payload_byte)(uint8_t);
    void (*reset_payload)(void);
    uint32_t tick_hz;
    uint8_t peer[8];
    uint32_t peer_rx_tick;
    size_t startup_step;
    bool startup_backoff;
    uint32_t startup_retry_tick;
    uint8_t next_id;
    PendingRequest rf;
    PendingRequest at;
    AtCommand at_command;
    uint8_t uart_tx_id;
    uint32_t uart_tx_tick;
    uint8_t tx_wire[TX_WIRE_CAPACITY];
    bool db_needed;
    bool db_requested;
    uint32_t db_tick;
    uint32_t diagnostic_tick;
    size_t diagnostic_step;
    RxState rx_state;
    uint16_t rx_length;
    uint16_t rx_used;
    uint8_t rx_sum;
    uint32_t rx_tick;
    uint8_t rx_data[RX_DATA_CAPACITY];
    RadioApiStats_t stats;
} radio;

/* A critical section protects the telemetry copy and stats snapshot across tasks. */
static struct {
    uint16_t length;
    uint8_t bytes[RF_BUFFER_CAPACITY];
} telemetry;
static RadioApiStats_t stats_snapshot;

static bool Elapsed(uint32_t now, uint32_t start, uint32_t milliseconds)
{
    const uint32_t ticks = (uint32_t)(((uint64_t)radio.tick_hz * milliseconds + 999U) / 1000U);
    return (uint32_t)(now - start) >= ticks;
}

void RadioApi_Init(bool (*on_payload_byte)(uint8_t), void (*reset_payload)(void))
{
    radio.on_payload_byte = on_payload_byte;
    radio.reset_payload = reset_payload;
    radio.tick_hz = osKernelGetTickFreq();
}

bool RadioApi_QueueTelemetry(const char *text)
{
    if (text == NULL)
        return false;

    const size_t length = strlen(text);
    if (length == 0U || length > sizeof(telemetry.bytes))
        return false;

    taskENTER_CRITICAL();
    memcpy(telemetry.bytes, text, length);
    telemetry.length = (uint16_t)length;
    taskEXIT_CRITICAL();
    return true;
}

void RadioApi_GetStats(RadioApiStats_t *out)
{
    taskENTER_CRITICAL();
    *out = stats_snapshot;
    taskEXIT_CRITICAL();
}

static void RestartStartup(uint32_t now, bool backoff)
{
    radio.stats.ready = false;
    radio.stats.rf_payload_limit = 0U;
    radio.startup_step = 0U;
    radio.startup_backoff = backoff;
    radio.startup_retry_tick = now;
    radio.at.id = 0U;
}

static void FailAtRequest(uint32_t now)
{
    ++radio.stats.at_errors;
    radio.at.id = 0U;
    if (!radio.stats.ready)
        RestartStartup(now, true);
}

static void HandleAtResponse(const uint8_t *data, uint16_t length, uint32_t now)
{
    const AtCommand command = radio.at_command;
    if (length < 5U || radio.at.id == 0U || data[1] != radio.at.id ||
        data[2] != (uint8_t)at_names[command][0] || data[3] != (uint8_t)at_names[command][1])
        return;

    const uint16_t value_length = length - 5U;
    const uint8_t *value = &data[5];
    if (data[4] != 0U || value_length == 0U || value_length > at_value_limits[command]) {
        FailAtRequest(now);
        return;
    }
    radio.at.id = 0U;

    if (command == AT_DH || command == AT_DL) {
        uint8_t *half = &radio.peer[command == AT_DH ? 0U : 4U];
        memset(half, 0, 4U);
        memcpy(&half[4U - value_length], value, value_length);
        ++radio.startup_step;
        return;
    }

    const uint16_t number = value_length == 2U ? ((uint16_t)value[0] << 8) | value[1] : value[0];
    switch (command) {
    case AT_NP: {
        /* Zero, broadcast, and 16-bit addresses all have a zero prefix. */
        static const uint8_t zero_prefix[6] = {0};
        if (number == 0U || memcmp(radio.peer, zero_prefix, sizeof(zero_prefix)) == 0) {
            FailAtRequest(now);
            return;
        }
        radio.stats.rf_payload_limit = number;
        radio.stats.ready = true;
        radio.diagnostic_tick = now;
        break;
    }
    case AT_DB:
        radio.stats.rssi_valid = number != 0U;
        radio.stats.rssi_dbm = -(int16_t)number;
        radio.stats.rssi_tick = now;
        break;
    case AT_EA:
        radio.stats.mac_ack_timeouts = number;
        radio.stats.counter_valid |= 0x01U;
        break;
    case AT_ER:
        radio.stats.rf_receive_errors = number;
        radio.stats.counter_valid |= 0x02U;
        break;
    case AT_TR:
        radio.stats.mac_transmit_failures = number;
        radio.stats.counter_valid |= 0x04U;
        break;
    case AT_VR:
        radio.stats.firmware_version = number;
        radio.stats.counter_valid |= 0x08U;
        break;
    default:
        break;
    }
}

static void DispatchFrame(uint32_t now)
{
    const uint8_t *data = radio.rx_data;
    const uint16_t length = radio.rx_length;

    switch (data[0]) {
    case XBEE_RECEIVE:
        if (length < 12U || !radio.stats.ready || (data[11] & 0x02U) != 0U ||
            memcmp(&data[1], radio.peer, sizeof(radio.peer)) != 0)
            break;
        if (Elapsed(now, radio.peer_rx_tick, COMMAND_FRAGMENT_IDLE_MS))
            radio.reset_payload();
        radio.peer_rx_tick = now;
        ++radio.stats.peer_packets;
        radio.db_needed = true;
        for (uint16_t i = 12U; i < length; ++i) {
            if (radio.on_payload_byte(data[i])) {
                radio.stats.command_seen = true;
                radio.stats.command_tick = now;
            }
        }
        break;

    case XBEE_TRANSMIT_STATUS:
        if (length != 7U || radio.rf.id == 0U || data[1] != radio.rf.id)
            break;
        radio.rf.id = 0U;
        radio.stats.last_tx_id = data[1];
        radio.stats.last_retry_count = data[4];
        radio.stats.last_delivery_status = data[5];
        radio.stats.last_discovery_status = data[6];
        if (data[5] == 0U)
            ++radio.stats.tx_success;
        else
            ++radio.stats.tx_failure;
        break;

    case XBEE_AT_RESPONSE:
        HandleAtResponse(data, length, now);
        break;

    case XBEE_MODEM_STATUS:
        if (length != 2U || data[1] > 1U)
            break;
        ++radio.stats.modem_resets;
        if (radio.rf.id != 0U)
            ++radio.stats.tx_missing_status;
        radio.rf.id = 0U;
        radio.stats.rssi_valid = false;
        radio.stats.counter_valid = 0U;
        radio.db_needed = false;
        radio.db_requested = false;
        radio.diagnostic_step = 0U;
        radio.reset_payload();
        RestartStartup(now, false);
        break;

    default:
        break;
    }
}

static void ResetRx(void)
{
    radio.rx_state = RX_START;
    radio.reset_payload();
}

static void ConsumeRxByte(uint8_t byte, uint32_t now)
{
    switch (radio.rx_state) {
    case RX_START:
        if (byte == XBEE_START)
            radio.rx_state = RX_LENGTH_HIGH;
        break;
    case RX_LENGTH_HIGH:
        radio.rx_length = (uint16_t)byte << 8;
        radio.rx_state = RX_LENGTH_LOW;
        break;
    case RX_LENGTH_LOW:
        radio.rx_length |= byte;
        if (radio.rx_length == 0U || radio.rx_length > sizeof(radio.rx_data)) {
            ++radio.stats.api_frame_errors;
            ResetRx();
            break;
        }
        radio.rx_used = 0U;
        radio.rx_sum = 0U;
        radio.rx_state = RX_DATA;
        break;
    case RX_DATA:
        radio.rx_data[radio.rx_used++] = byte;
        radio.rx_sum = (uint8_t)(radio.rx_sum + byte);
        if (radio.rx_used == radio.rx_length)
            radio.rx_state = RX_CHECKSUM;
        break;
    case RX_CHECKSUM:
        radio.rx_state = RX_START;
        if ((uint8_t)(radio.rx_sum + byte) == 0xFFU) {
            DispatchFrame(now);
        } else {
            ++radio.stats.api_frame_errors;
            ResetRx();
        }
        break;
    }
}

static void ReadUart(uint32_t now)
{
    uint8_t bytes[RX_BATCH_BYTES];
    for (size_t batch = 0; batch < RX_BATCH_COUNT; ++batch) {
        const uint32_t old_drops = radio.stats.uart_rx_drops;
        const uint32_t old_errors = radio.stats.uart_rx_errors;
        const size_t count = BoardRadio_Read(bytes, sizeof(bytes),
                                             &radio.stats.uart_rx_drops, &radio.stats.uart_rx_errors);
        if (old_drops != radio.stats.uart_rx_drops || old_errors != radio.stats.uart_rx_errors)
            ResetRx();

        if (count == 0U) {
            if (radio.rx_state != RX_START && Elapsed(now, radio.rx_tick, RX_FRAME_IDLE_MS)) {
                ++radio.stats.api_frame_errors;
                ResetRx();
            }
            break;
        }

        radio.rx_tick = now;
        for (size_t i = 0; i < count; ++i)
            ConsumeRxByte(bytes[i], now);
        if (count < sizeof(bytes))
            break;
    }
}

static uint8_t NextFrameId(void)
{
    do {
        ++radio.next_id;
    } while (radio.next_id == 0U || radio.next_id == radio.rf.id || radio.next_id == radio.at.id);
    return radio.next_id;
}

static bool SendFrame(uint16_t data_length, uint8_t id, uint32_t now)
{
    uint8_t *wire = radio.tx_wire;
    wire[0] = XBEE_START;
    wire[1] = (uint8_t)(data_length >> 8);
    wire[2] = (uint8_t)data_length;
    uint8_t sum = 0U;
    for (uint16_t i = 0; i < data_length; ++i)
        sum = (uint8_t)(sum + wire[3U + i]);
    wire[3U + data_length] = (uint8_t)(0xFFU - sum);

    if (!BoardRadio_StartTx(wire, data_length + 4U)) {
        ++radio.stats.uart_tx_errors;
        return false;
    }
    radio.uart_tx_id = id;
    radio.uart_tx_tick = now;
    return true;
}

static bool SendAt(AtCommand command, uint32_t now)
{
    const uint8_t id = NextFrameId();
    uint8_t *data = &radio.tx_wire[3];
    data[0] = XBEE_AT;
    data[1] = id;
    data[2] = (uint8_t)at_names[command][0];
    data[3] = (uint8_t)at_names[command][1];
    if (!SendFrame(4U, id, now))
        return false;

    radio.at = (PendingRequest){.id = id, .started = now};
    radio.at_command = command;
    return true;
}

static bool SendTelemetry(uint32_t now)
{
    uint8_t *data = &radio.tx_wire[3];
    taskENTER_CRITICAL();
    const uint16_t length = telemetry.length;
    if (length > 0U && length <= radio.stats.rf_payload_limit)
        memcpy(&data[14], telemetry.bytes, length);
    telemetry.length = 0U;
    taskEXIT_CRITICAL();

    if (length == 0U)
        return false;
    if (length > radio.stats.rf_payload_limit) {
        ++radio.stats.tx_payload_too_large;
        return false;
    }

    const uint8_t id = NextFrameId();
    data[0] = XBEE_TRANSMIT;
    data[1] = id;
    memcpy(&data[2], radio.peer, sizeof(radio.peer));
    data[10] = 0xFFU;
    data[11] = 0xFEU;
    data[12] = 0U;
    data[13] = 0U; /* Use the radio's TO setting. */
    if (!SendFrame(14U + length, id, now))
        return false;

    radio.rf = (PendingRequest){.id = id, .started = now};
    return true;
}

static void ServiceUartTransmit(uint32_t now)
{
    const uint8_t id = radio.uart_tx_id;
    if (id == 0U)
        return;
    if (BoardRadio_TxIdle()) {
        radio.uart_tx_id = 0U;
        if (radio.rf.id == id)
            radio.rf.started = now;
        if (radio.at.id == id)
            radio.at.started = now;
        return;
    }
    if (!Elapsed(now, radio.uart_tx_tick, UART_TX_TIMEOUT_MS))
        return;

    BoardRadio_AbortTx();
    radio.uart_tx_id = 0U;
    ++radio.stats.uart_tx_errors;
    if (radio.rf.id == id)
        radio.rf.id = 0U;
    if (radio.at.id == id)
        FailAtRequest(now);
}

static void ServiceRequests(uint32_t now)
{
    if (radio.rf.id != 0U && radio.rf.id != radio.uart_tx_id &&
        Elapsed(now, radio.rf.started, RF_STATUS_TIMEOUT_MS)) {
        radio.rf.id = 0U;
        ++radio.stats.tx_missing_status;
    }
    if (radio.at.id != 0U && radio.at.id != radio.uart_tx_id &&
        Elapsed(now, radio.at.started, AT_TIMEOUT_MS))
        FailAtRequest(now);

    if (radio.uart_tx_id != 0U || !BoardRadio_TxIdle())
        return;

    if (!radio.stats.ready) {
        if (radio.at.id == 0U && (!radio.startup_backoff ||
            Elapsed(now, radio.startup_retry_tick, STARTUP_RETRY_MS))) {
            if (!SendAt(startup_commands[radio.startup_step], now))
                RestartStartup(now, true);
        }
        return;
    }

    if (radio.at.id == 0U && radio.db_needed && (!radio.db_requested ||
        Elapsed(now, radio.db_tick, RSSI_INTERVAL_MS))) {
        radio.db_needed = false;
        radio.db_requested = true;
        radio.db_tick = now;
        if (SendAt(AT_DB, now))
            return;
    }

    if (radio.rf.id == 0U && SendTelemetry(now))
        return;

    if (radio.at.id == 0U && Elapsed(now, radio.diagnostic_tick, DIAGNOSTIC_INTERVAL_MS)) {
        radio.diagnostic_tick = now;
        SendAt(diagnostic_commands[radio.diagnostic_step], now);
        radio.diagnostic_step = (radio.diagnostic_step + 1U) % (sizeof(diagnostic_commands) /
                                                                 sizeof(diagnostic_commands[0]));
    }
}

void RadioApi_Poll(void)
{
    const uint32_t now = osKernelGetTickCount();
    ServiceUartTransmit(now);
    ReadUart(now);
    ServiceRequests(now);

    taskENTER_CRITICAL();
    stats_snapshot = radio.stats;
    taskEXIT_CRITICAL();
}

void RadioApi_PrintDiagnostics(void)
{
    static char line[384]; /* Called by TelemetryTask only. */
    RadioApiStats_t stats;
    char rssi[40] = "n/a";
    char command_age[20] = "n/a";
    RadioApi_GetStats(&stats);
    const uint32_t now = osKernelGetTickCount();
    const uint32_t tick_hz = osKernelGetTickFreq();
    if (stats.rssi_valid) {
        const uint32_t ticks = now - stats.rssi_tick;
        const unsigned long age_ms = (unsigned long)(((uint64_t)ticks * 1000U) / tick_hz);
        snprintf(rssi, sizeof(rssi), "%d dBm/%lu ms", (int)stats.rssi_dbm, age_ms);
    }
    if (stats.command_seen) {
        const uint32_t ticks = now - stats.command_tick;
        const unsigned long age_ms = (unsigned long)(((uint64_t)ticks * 1000U) / tick_hz);
        snprintf(command_age, sizeof(command_age), "%lu", age_ms);
    }

    snprintf(line, sizeof(line),
        "XB ready=%u NP=%u RSSI=%s rx=%lu cmd_age_ms=%s tx(ok/fail/miss/large)=%lu/%lu/%lu/%lu "
        "last(id/code/retry/disc)=%u/%02X/%u/%02X api=%lu uart(drop/rx/tx)=%lu/%lu/%lu "
        "AT=%lu resets=%lu EA/ER/TR=%u/%u/%u VR=%04X valid=%X\r\n",
        (unsigned)stats.ready, (unsigned)stats.rf_payload_limit, rssi, (unsigned long)stats.peer_packets, command_age,
        (unsigned long)stats.tx_success, (unsigned long)stats.tx_failure, (unsigned long)stats.tx_missing_status,
        (unsigned long)stats.tx_payload_too_large, (unsigned)stats.last_tx_id,
        (unsigned)stats.last_delivery_status, (unsigned)stats.last_retry_count, (unsigned)stats.last_discovery_status,
        (unsigned long)stats.api_frame_errors, (unsigned long)stats.uart_rx_drops,
        (unsigned long)stats.uart_rx_errors, (unsigned long)stats.uart_tx_errors,
        (unsigned long)stats.at_errors, (unsigned long)stats.modem_resets,
        (unsigned)stats.mac_ack_timeouts, (unsigned)stats.rf_receive_errors,
        (unsigned)stats.mac_transmit_failures, (unsigned)stats.firmware_version, (unsigned)stats.counter_valid);
    Debug_Print(line);
}

#endif /* RADIOMODE */
