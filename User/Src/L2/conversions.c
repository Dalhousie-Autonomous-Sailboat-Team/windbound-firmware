#include "conversions.h"
#include <stddef.h>
#include <string.h>

/* -------------------------------------------------------------------------
 * StringToFloat
 * ------------------------------------------------------------------------- */
float Conversions_StringToFloat(const char *str)
{
    if (str == NULL || *str == '\0')
        return 0.0f;

    float result = 0.0f;
    float decimal_divisor = 1.0f;
    bool negative = false;
    bool in_decimal = false;

    if (*str == '-')
    {
        negative = true;
        str++;
    }
    else if (*str == '+')
    {
        str++;
    }

    while (*str)
    {
        if (*str == '.')
        {
            if (in_decimal) break; // second dot — stop parsing
            in_decimal = true;
        }
        else if (*str >= '0' && *str <= '9')
        {
            uint8_t digit = *str - '0';

            if (!in_decimal)
            {
                result = result * 10.0f + digit;
            }
            else
            {
                decimal_divisor *= 10.0f;
                result += (float)digit / decimal_divisor;
            }
        }
        else
        {
            break; // non-numeric character — stop parsing
        }

        str++;
    }

    return negative ? -result : result;
}

/* -------------------------------------------------------------------------
 * FloatToString
 * ------------------------------------------------------------------------- */

// Helper: write an integer into a buffer, returns number of characters written
static uint8_t write_integer(uint32_t value, char *buf, uint8_t buf_size)
{
    if (buf_size == 0) return 0;

    char tmp[12];
    uint8_t len = 0;

    if (value == 0)
    {
        tmp[len++] = '0';
    }
    else
    {
        while (value > 0 && len < sizeof(tmp))
        {
            tmp[len++] = '0' + (value % 10);
            value /= 10;
        }
    }

    // tmp is in reverse order
    if (len > buf_size) return 0;

    for (uint8_t i = 0; i < len; i++)
        buf[i] = tmp[len - 1 - i];

    return len;
}

bool Conversions_FloatToString(float value, char *buf, uint8_t buf_size, uint8_t decimal_places)
{
    if (buf == NULL || buf_size == 0)
        return false;

    uint8_t pos = 0;

    // Handle negative
    if (value < 0.0f)
    {
        if (pos >= buf_size - 1) return false;
        buf[pos++] = '-';
        value = -value;
    }

    // Round value to the requested decimal places
    float rounding = 0.5f;
    for (uint8_t i = 0; i < decimal_places; i++)
        rounding /= 10.0f;
    value += rounding;

    // Integer part
    uint32_t int_part = (uint32_t)value;
    uint8_t written = write_integer(int_part, buf + pos, buf_size - pos - 1);
    if (written == 0 && int_part != 0) return false;
    pos += written;

    // Decimal part
    if (decimal_places > 0)
    {
        if (pos >= buf_size - 1) return false;
        buf[pos++] = '.';

        float decimal = value - (float)int_part;

        for (uint8_t i = 0; i < decimal_places; i++)
        {
            decimal *= 10.0f;
            uint8_t digit = (uint8_t)decimal;
            if (pos >= buf_size - 1) return false;
            buf[pos++] = '0' + digit;
            decimal -= digit;
        }
    }

    buf[pos] = '\0';
    return true;
}