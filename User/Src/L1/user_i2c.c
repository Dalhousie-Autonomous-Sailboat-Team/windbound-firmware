#include "user_i2c.h"
#include "stm32h5xx_hal.h"
#include "app_freertos.h"



extern I2C_HandleTypeDef hi2c2;

extern osSemaphoreId_t i2c2_semaphoreHandle;

/* -------------------------------------------------------------------------
 * UserI2C_Write
 * ------------------------------------------------------------------------- */
bool UserI2C_Write(uint16_t address, uint8_t *data, uint16_t length, uint32_t timeout)
{
    /* Kick off interrupt driven transmit */
    HAL_StatusTypeDef status = HAL_I2C_Master_Transmit_IT(&hi2c2, address, data, length);
    if (status != HAL_OK)
        return false;

    /* Sleep until interrupt fires and gives the semaphore */
    if (osSemaphoreAcquire(i2c2_semaphoreHandle, timeout) != osOK)
        return false;

    return true;
}

/* -------------------------------------------------------------------------
 * UserI2C_Read
 * ------------------------------------------------------------------------- */
bool UserI2C_Read(uint16_t address, uint8_t *buffer, uint16_t length, uint32_t timeout)
{
    /* Kick off interrupt driven receive */
    HAL_StatusTypeDef status = HAL_I2C_Master_Receive_IT(&hi2c2, address, buffer, length);
    if (status != HAL_OK)
        return false;

    /* Sleep until interrupt fires and gives the semaphore */
    if (osSemaphoreAcquire(i2c2_semaphoreHandle, timeout) != osOK)
        return false;

    return true;
}

/* -------------------------------------------------------------------------
 * HAL Callbacks — called from interrupt context when transaction completes
 * ------------------------------------------------------------------------- */
void HAL_I2C_MasterTxCpltCallback(I2C_HandleTypeDef *hi2c)
{
    if (hi2c == &hi2c2)
        osSemaphoreRelease(i2c2_semaphoreHandle);
}

void HAL_I2C_MasterRxCpltCallback(I2C_HandleTypeDef *hi2c)
{
    if (hi2c == &hi2c2)
        osSemaphoreRelease(i2c2_semaphoreHandle);
}

void HAL_I2C_ErrorCallback(I2C_HandleTypeDef *hi2c)
{
    if (hi2c == &hi2c2)
        osSemaphoreRelease(i2c2_semaphoreHandle);
}