/**
 * Largest Triangle Three Buckets (LTTB) Downsampling Algorithm.
 * 
 * This algorithm downsamples data while preserving visual shape (peaks and valleys),
 * unlike simple decimation (taking every Nth point).
 * 
 * Reference: Sveinn Steinarsson (2013)
 * 
 * @param {Array} data - Array of arrays [[x,y], [x,y], ...]
 * @param {Number} threshold - Target number of points
 * @returns {Array} - Downsampled array [[x,y], ...]
 */
export function lttb(data, threshold) {
    const dataLength = data.length;
    
    // If data is smaller than threshold, return original
    if (threshold >= dataLength || threshold === 0) {
        return data; 
    }

    const sampled = [];
    let sampledIndex = 0;

    // Bucket size. Leave room for start and end data points
    const every = (dataLength - 2) / (threshold - 2);

    let a = 0; // Initially the first point
    let maxAreaPoint, nextA;

    sampled[sampledIndex++] = data[a]; // Always add the first point

    for (let i = 0; i < threshold - 2; i++) {
        // Calculate point average for next bucket (containing c)
        let avgX = 0;
        let avgY = 0;
        let avgRangeStart = Math.floor((i + 1) * every) + 1;
        let avgRangeEnd = Math.floor((i + 2) * every) + 1;
        avgRangeEnd = avgRangeEnd < dataLength ? avgRangeEnd : dataLength;

        const avgRangeLength = avgRangeEnd - avgRangeStart;

        for (; avgRangeStart < avgRangeEnd; avgRangeStart++) {
            avgX += data[avgRangeStart][0]; 
            avgY += data[avgRangeStart][1];
        }

        avgX /= avgRangeLength;
        avgY /= avgRangeLength;

        // Get the range for this bucket
        let rangeOffs = Math.floor((i + 0) * every) + 1;
        let rangeTo = Math.floor((i + 1) * every) + 1;

        // Point a
        const pointAx = data[a][0]; 
        const pointAy = data[a][1];

        maxAreaPoint = -1;
        let maxArea = -1;

        for (; rangeOffs < rangeTo; rangeOffs++) {
            // Calculate triangle area over three buckets
            const area = Math.abs(
                (pointAx - avgX) * (data[rangeOffs][1] - pointAy) -
                (pointAx - data[rangeOffs][0]) * (avgY - pointAy)
            ) * 0.5;

            if (area > maxArea) {
                maxArea = area;
                maxAreaPoint = data[rangeOffs];
                nextA = rangeOffs; // Next a is this b
            }
        }

        sampled[sampledIndex++] = maxAreaPoint; // Pick this point from the bucket
        a = nextA; // This a is the next a (chosen b)
    }

    sampled[sampledIndex++] = data[dataLength - 1]; // Always add last point

    return sampled;
}