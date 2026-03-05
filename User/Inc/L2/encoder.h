#ifndef ENCODER_H
#define ENCODER_H

#include <stdint.h>
#include <stdbool.h>

/* AS5600 I2C address shifted left by 1 for HAL */
#define AS5600_I2C_ADDRESS      (0x36 << 1)

/* Angle output registers */
#define AS5600_REG_ANGLE_HIGH   0x0E
#define AS5600_REG_ANGLE_LOW    0x0F

/* Conversion constants */
#define AS5600_RAW_MAX          4096.0f
#define AS5600_DEGREES_MAX      360.0f

#define AS5600_I2C_TIMEOUT_MS   100


typedef struct
{
    uint8_t channel;      /* Mux channel the reading came from (4)  */
    float   angle;        /* Degrees, 0.0 – 360.0                   */
} EncoderSample_t;

/**
 * @brief Read the current angle from the AS5600
 *
 * Sequence:
 * 1. Write register pointer to 0x0E (ANGLE high byte)
 * 2. Read 2 bytes (high byte then low byte)
 * 3. Combine into 12-bit value and convert to degrees
 *
 * @param angle_degrees  Pointer to float to store result in degrees 0.0 - 360.0
 * @return true          If read succeeded
 * @return false         If I2C transaction failed
 */
bool AS5600_ReadAngle(float *angle_degrees);


/* ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------*/
void Encoder_Init(void);
bool Encoder_SelectMuxChannel(uint8_t channel);
void Encoder_UpdateLatest(const EncoderSample_t *sample);
bool Encoder_GetLatest(EncoderSample_t *out);
void EncoderTask(void *argument);


#endif /* ENCODER_H */