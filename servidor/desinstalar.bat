@echo off
rem Abre o desinstalador como Administrador (pede confirmacao do Windows)
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File \"%~dp0desinstalar.ps1\"'"
