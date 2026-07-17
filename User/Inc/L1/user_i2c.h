#ifndef USER_I2C_H
#define USER_I2C_H

#include <stdint.h>
#include <stdbool.h>
#include "cmsis_os2.h"
#include "stm32h5xx_hal.h"

/* I2C completion semaphore — accessible by callbacks */
extern osSemaphoreId_t i2c2_semaphore;

/**
 * @brief Initialize the I2C driver
 * Creates the semaphore used for interrupt synchronization
 */
void UserI2C_Init(void);

/**
 * @brief Write bytes to an I2C device
 *
 * @param address   7-bit device address shifted left by 1
 * @param data      Pointer to data buffer to send
 * @param length    Number of bytes to send
 * @param timeout   Timeout in milliseconds
 * @return true     If transaction completed successfully
 * @return false    If transaction failed or timed out
 */
bool UserI2C_Write(uint16_t address, uint8_t *data, uint16_t length, uint32_t timeout);

/**
 * @brief Read bytes from an I2C device
 *
 * @param address   7-bit device address shifted left by 1
 * @param buffer    Pointer to buffer to store received data
 * @param length    Number of bytes to read
 * @param timeout   Timeout in milliseconds
 * @return true     If transaction completed successfully
 * @return false    If transaction failed or timed out
 */
bool UserI2C_Read(uint16_t address, uint8_t *buffer, uint16_t length, uint32_t timeout);

#endif /* USER_I2C_H */