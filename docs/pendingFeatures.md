This document outlines features that could be added in attempt to gether thoughts before diving in.

Tweaks to filters:
- 

Cursors and analysis:
- Impliment oscilloscope type cursors - lines which are either on the x or y axis and allow the user to inspect the data (difference in x or y values...). Generally osciloscope x-axis cursors will have a line going vertically through the y-axis. This then picks up on the value where the trace crosses it and gives the x and y values - the same happens with a y-axis cursor.
- Detect ruse time and frequency of pulses - ensure these are very robust.
- Detect PWM percentage, RMS and other similar metrics for waveforms - ensure these are robust.

UI improvements:
- Build in support for pasting data into the grid view and copying it out - which likely means it needs enhancing and allowing filters to show raw and/or processed data.
- Improve the feel of controls and the UI.

Help system improvements:
- Increase the clarity of examples for each filter type and all added finctionality.

Export improvements:
- Further improve the custom graph output size.

Data importing:
- If possible, build import modules for different file types. This means making the whole import system modular. If possible, oscilloscope specific filetypes would be great.

Graphing improvements:
- Allow the user to specify numerically the limits of what to plot
- The x-axis is often in seconds, it would be good to be able to multiply the value by say 1e9 for display.

Multi-waveform view:
- This should allow the user to choose which of the filtered waveforms they wish to compose into a single plot.
- Each waveform should have a time offset control (for aligning the riseing edges fro example). This will be linked to the data's own tabs where the control should be also.

Waveform math:
- A new pipeline type tool which creates a new tab.
- This allows the user to perform quite complex math functions on traces that have been filtered in other tabs.
- It raises the point that if there are no filters, there is presently no filtered waveform to do math with. We need to introduce an invisable "null" filter which sits in the pipeline and passes the raw data to the output. That way, there's consistancy and always a waveform to work with - as the user does not get to use unfiltered data. If they want that, they dimply shouldn't use a filter...
- This likely require building several use cases to describe what I want to be able to do.
-- A) Find the time varying impedance of a system. Input waveforms are noisy voltage and current waveforms. These are smoothed and filtered well and offsets nicely dealt with. Then the obvious formula is V/I = Z. But, when I is very small, or zero, before a waveform in itiates, Z has a tendancy to wards infinity. Thus, it might be better to use an equation like V/(I+constant) = Z. But we'll also find that it keeps switching sine as V is roughly zero and essentailly noise pushes it either side of zero. Thus we may want to use (V+k_V)/(I+k_I) = Z, where k_V and k_I are small but useful constants to encorage both numbers to be above zero and tend Z to equal +1 until the waveform gets underway. The impedance waveform is returned.
-- B) The user might want to find the action integral of a current waveform. The relevent units here are A^2s. To perform this, the current is squared and then integrated. This requires taking the filtered current waveform, squaring it and integrating it then returning the resultant waveform. Generally this has a sudden increase and levels off for most waveforms under test. But for sine waves or similar, it resembles stairs.
-- C) The user has 4 pressure sensors and knows they're all a bit noisy, so aside from the input noise filtering on all 4 of the pressure sensor raw data sets, they are combined and averaged. Obviously this is add them together and divide by 4, but wrapping this in an average function would be nice.
-- D) The user wants to explore the math functions. They want to be able to perform complex, multi stage math, where several traces are scaled and offsets applied before one is differentiated, another integrated and then a final function delivers a trace based on all of them. The output is again a new trace. This is purpously vague - there needs to be flexability. There needs to be the ability to have variables which are intermediate containers of calculated arrays. We're not building a programming language here, but we are allowing for calculation based on arrays and scalars. We do expect to be able to use max(), min(), average(), abs() and so forth functions on arrays and next equations.