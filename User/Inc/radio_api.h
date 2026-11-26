#ifndef RADIO_API_H
#define RADIO_API_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef RADIOMODE

typedef struct {
    bool ready;
    uint16_t rf_payload_limit;
    uint16_t firmware_version;
    uint8_t counter_valid; /* Bits 0..3 correspond to EA, ER, TR, VR. */
    uint16_t mac_ack_timeouts;
    uint16_t rf_receive_errors;
    uint16_t mac_transmit_failures;
    bool rssi_valid;
    int16_t rssi_dbm;
    uint32_t rssi_tick;
    bool command_seen;
    uint32_t command_tick;
    uint32_t peer_packets;
    uint32_t tx_success;
    uint32_t tx_failure;
    uint32_t tx_missing_status;
    uint32_t tx_payload_too_large;
    uint8_t last_tx_id; /* Zero until the first matching 0x8B. */
    uint8_t last_delivery_status;
    uint8_t last_retry_count;
    uint8_t last_discovery_status;
    uint32_t api_frame_errors;
    uint32_t uart_rx_drops;
    uint32_t uart_rx_errors;
    uint32_t uart_tx_errors;
    uint32_t at_errors;
    uint32_t modem_resets;
} RadioApiStats_t;

/* Init and Poll run in UARTParserTask. QueueTelemetry and GetStats are task APIs. */
void RadioApi_Init(bool (*on_payload_byte)(uint8_t), void (*reset_payload)(void));
void RadioApi_Poll(void);
bool RadioApi_QueueTelemetry(const char *text);
void RadioApi_GetStats(RadioApiStats_t *out);
void RadioApi_PrintDiagnostics(void);

/* UART8 hooks provided by board_io.c. The caller owns the TX buffer until idle. */
size_t BoardRadio_Read(uint8_t *out, size_t capacity, uint32_t *drops, uint32_t *errors);
bool BoardRadio_TxIdle(void);
bool BoardRadio_StartTx(uint8_t *bytes, uint16_t length);
void BoardRadio_AbortTx(void);

#endif /* RADIOMODE */
#endif /* RADIO_API_H */
