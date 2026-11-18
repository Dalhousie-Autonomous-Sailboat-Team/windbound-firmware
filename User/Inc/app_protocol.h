#ifndef APP_PROTOCOL_H
#define APP_PROTOCOL_H

#include <stdbool.h>
#include <stddef.h>

#include "app_state.h"
#include "encoder.h"

bool AppProtocol_ParseWindNmea(const char *sentence, WindSample_t *sample);
bool AppProtocol_ParseXbeeCommand(const char *packet, XbeeCommand_t *cmd);
bool AppProtocol_ParseRpiSample(const char *packet, RPiSample_t *rpi);

/* Format the telemetry line sent to the ground station over the radio.
 * Returns false if the line did not fit in the buffer. */
bool AppProtocol_FormatTelemetry(char *buf, size_t len, const RPiSample_t *rpi,
                                 const EncoderSample_t *sail_enc);

/* Format the line sent to the Raspberry Pi with the windvane's reading:
 * the apparent wind angle, its speed in m/s, the reference ('R' relative or
 * 'T' true) and whether it is valid: the vane says so and its last sentence
 * is under WIND_STALE_MS old. Returns false if the line did not fit. */
#define WIND_STALE_MS 3000U
bool AppProtocol_FormatSensorInput(char *buf, size_t len, const WindSample_t *wind,
                                   uint32_t now_ms);

float StringToFloat(const char *str);
void FloatToString(float value, char *buf);

#endif /* APP_PROTOCOL_H */
