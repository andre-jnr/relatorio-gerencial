@echo off
rem Abre o instalador como Administrador (pede confirmacao do Windows)
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File \"%~dp0instalar.ps1\"'"
