#ifndef CONVERSIONS_H
#define CONVERSIONS_H

#include <stdint.h>
#include <stdbool.h>

/**
 * @brief Convert a numeric string to a float
 * Handles optional leading '-', integer and decimal parts.
 * Returns 0.0f if the string is NULL, empty, or non-numeric.
 *
 * @param str   Null-terminated input string e.g. "226.0", "-12.5"
 * @return float Parsed value
 */
float Conversions_StringToFloat(const char *str);

/**
 * @brief Convert a float to a string
 * Writes result into a caller-provided buffer.
 * Does not use sprintf/printf.
 *
 * @param value         Float value to convert
 * @param buf           Output buffer
 * @param buf_size      Size of output buffer
 * @param decimal_places Number of digits after the decimal point
 * @return true         If conversion succeeded
 * @return false        If buffer is NULL or too small
 */
bool Conversions_FloatToString(float value, char *buf, uint8_t buf_size, uint8_t decimal_places);

#endif /* CONVERSIONS_H */ /*** end of file ***/