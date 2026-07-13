#!/bin/bash
source "$(dirname "$0")/shared-functions.sh"
emit_url "projects/stm32-games"

clear
echo ""
ascii_typewriter "stm32 games" "DOS_Rebel" "${RED}"

echo ""
create_box "Description" "Complete snake game running on an STM32 Blue Pill with an ST7789 LCD,
written in C. Built to learn bare-metal programming on a microcontroller." "${RED}"

echo ""
typewriter "${BLUE}Tech Stack:${RESET}"
animated_separator "~" 10 "${RED}"
typewriter "   ${RED}•${RESET} C with Makefile and ARM GCC"
typewriter "   ${RED}•${RESET} STM32F103C8 (Blue Pill) microcontroller"
typewriter "   ${RED}•${RESET} Custom C ST7789 SPI LCD display driver"
typewriter "   ${RED}•${RESET} libopencm3 library"

git_activity "${RED}"

echo ""

typewriter "${RED}You are now in the projects/stm32-games directory${RESET}"
typewriter "${DIM}Use ls, tree, cat, nvim, or other commands to explore the actual git repository of this project,${RESET}"
typewriter "${DIM}or type home to go back to the home page ${RESET}"
echo ""
