# Third-party notices

SignalForge's native oscilloscope readers are independent, bounded TypeScript
implementations validated with format documentation and redistributable fixture
corpora. They do not embed the reference browser parsers or a Kaitai runtime.

## RigolWFM reference material and fixtures

Format facts and fixtures for Keysight/Agilent, Rohde & Schwarz, Teledyne
LeCroy and Rigol were validated against RigolWFM 1.5.0, source commit
`159e647c0b74e1d73d0ad589149e1c26e1610b26`.

BSD 3-Clause License

Copyright (c) 2020-23, Scott Prahl
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Tektronix tm_data_types fixtures

The Tektronix WFM#003 validation fixtures originate from
[`tektronix/tm_data_types`](https://github.com/tektronix/tm_data_types), source
commit `8b30570bb512c31b63917b54f159d699875ab0e8`, under Apache License 2.0.
The complete license text is retained at
`reference-material/SignalForge-scope-import-examples/third_party/TEKTRONIX_TM_DATA_TYPES_LICENSE.md`.

## Excluded material

The PicoScope PSDATA forum attachment is not required by the application or
tests and must not be distributed. PSDATA support is limited to signature
detection and vendor conversion guidance.
