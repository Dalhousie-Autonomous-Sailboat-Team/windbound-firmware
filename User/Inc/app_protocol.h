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

float StringToFloat(const char *str);
void FloatToString(float value, char *buf);

#endif /* APP_PROTOCOL_H */
