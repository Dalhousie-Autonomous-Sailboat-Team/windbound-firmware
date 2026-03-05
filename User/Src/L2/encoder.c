#include "L2/encoder.h"
#include "L1/user_i2c.h"

bool AS5600_ReadAngle(float *angle_degrees)
{
    if (angle_degrees == NULL)
        return false;

    /* Step 1 — point AS5600 to ANGLE high byte register */
    uint8_t reg = AS5600_REG_ANGLE_HIGH;
    if (!UserI2C_Write(AS5600_I2C_ADDRESS, &reg, 1, AS5600_I2C_TIMEOUT_MS))
        return false;

    /* Step 2 — read 2 bytes (high byte + low byte) */
    uint8_t rx_buf[2] = {0};
    if (!UserI2C_Read(AS5600_I2C_ADDRESS, rx_buf, 2, AS5600_I2C_TIMEOUT_MS))
        return false;

    /* Step 3 — combine into 12-bit raw value */
    uint16_t raw = ((uint16_t)(rx_buf[0] & 0x0F) << 8) | rx_buf[1];

    /* Step 4 — convert to degrees */
    *angle_degrees = ((float)raw / AS5600_RAW_MAX) * AS5600_DEGREES_MAX;

    return true;
} 



 