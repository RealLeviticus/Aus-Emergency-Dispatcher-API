/**
 * Real Australian military airspace, from the RAAF's own published handbook.
 *
 * Source: Flight Information Handbook Australia (FIHA), AIRAC cycle 2609,
 * effective 03 SEP 2026 — ENR 5 sections 3 (Military AAR and AEW&C airspace
 * anchor waypoints) and 6 (Refuelling tracks), published by RAAF Aeronautical
 * Information Services at ais-af.airforce.gov.au.
 *
 * Why this exists: air-to-air refuelling used to happen on a random bearing at a
 * random distance from the base, which put a KC-30A towline wherever the RNG
 * felt like. Australia refuels on a short list of named, published tracks, and
 * those names — GUKVI, PETRL, EXXON, CALTX — are what a brief should say.
 *
 * The anchor waypoints are transcribed by script from the PDF and checked two
 * ways: each is attributed by its own name prefix (AMX -> Amberley) rather than
 * by position in the document, and every one is verified to sit inside the
 * Australian FIR and within a sensible range of the base it is filed under.
 * The refuelling tracks are hand-transcribed — there are only eight and the
 * PDF's table layout does not survive text extraction.
 *
 * This is public aeronautical information reproduced for flight simulation. It
 * is NOT for real-world navigation: it is one cycle deep, never updated, and
 * the sim's own terrain and airspace do not match the real world anyway.
 */

export type Waypoint = { id: string; lat: number; lon: number };

/**
 * A published refuelling track. `points` runs in the direction the track is
 * flown, from the rendezvous initial point to the exit point.
 */
export type RefuellingTrack = {
  /** designator as published, e.g. "W946 (South)" */
  name: string;
  /** rendezvous initial point — where the receivers join */
  rvip: string;
  /** rendezvous control point — where the tanker sets up */
  rvcp: string;
  /** navigation check point */
  navChk: string;
  /** exit point */
  exit: string;
  /** the block the track is flown in */
  altitudes: string;
  /** primary refuelling frequency */
  freq: string;
  /** the ATS centre that owns the airspace */
  centre: string;
  points: Waypoint[];
};

/**
 * Every RAAF refuelling track in the FIHA. W951/W953/W954 are published in both
 * directions; each direction is its own entry because which way you fly it
 * changes where you join and where you come off.
 */
export const REFUELLING_TRACKS: RefuellingTrack[] = [
  {
    name: 'W946 (South)',
    rvip: 'GUKVI',
    rvcp: 'PETRL',
    navChk: 'TEXAN',
    exit: 'AGETA',
    altitudes: 'FL250/FL300',
    freq: '301.500',
    centre: 'Brisbane Centre',
    points: [
      { id: 'GUKVI', lat: -16.24833, lon: 134.26 },
      { id: 'PETRL', lat: -17.20444, lon: 135.35958 },
      { id: 'TEXAN', lat: -19.01167, lon: 137.49 },
      { id: 'MA', lat: -20.66461, lon: 139.48564 },
      { id: 'VALDZ', lat: -23.45, lon: 141.69667 },
      { id: 'EXXON', lat: -25.77667, lon: 143.65167 },
      { id: 'CMU', lat: -28.03478, lon: 145.62375 },
      { id: 'CARBN', lat: -29.12272, lon: 146.96869 },
      { id: 'AGETA', lat: -30.02864, lon: 148.12842 },
    ],
  },
  {
    name: 'W951 (West)',
    rvip: 'ROM',
    rvcp: 'ESLES',
    navChk: 'LIDBU',
    exit: 'VALDZ',
    altitudes: 'FL250/FL300',
    freq: '301.500',
    centre: 'Brisbane Centre',
    points: [
      { id: 'ROM', lat: -26.54308, lon: 148.78169 },
      { id: 'ESLES', lat: -25.97531, lon: 147.39069 },
      { id: 'LIDBU', lat: -24.75681, lon: 144.55042 },
      { id: 'VALDZ', lat: -23.45, lon: 141.69667 },
    ],
  },
  {
    name: 'W951 (East)',
    rvip: 'VALDZ',
    rvcp: 'LIDBU',
    navChk: 'ESLES',
    exit: 'ROM',
    altitudes: 'FL250/FL300',
    freq: '301.500',
    centre: 'Brisbane Centre',
    points: [
      { id: 'VALDZ', lat: -23.45, lon: 141.69667 },
      { id: 'LIDBU', lat: -24.75681, lon: 144.55042 },
      { id: 'ESLES', lat: -25.97531, lon: 147.39069 },
      { id: 'ROM', lat: -26.54308, lon: 148.78169 },
    ],
  },
  {
    name: 'W952 (North)',
    rvip: 'AMOCO',
    rvcp: 'KELPI',
    navChk: 'BOOMA',
    exit: 'CALTX',
    altitudes: 'FL250/FL300',
    freq: '301.500',
    centre: 'Brisbane Centre',
    points: [
      { id: 'AMOCO', lat: -24.0, lon: 152.20833 },
      { id: 'KELPI', lat: -22.5695, lon: 151.58656 },
      { id: 'BOOMA', lat: -20.0, lon: 150.68667 },
      { id: 'LAMEK', lat: -18.15461, lon: 150.04319 },
      { id: 'CALTX', lat: -17.0, lon: 149.65381 },
    ],
  },
  {
    name: 'W953 (South)',
    rvip: 'NOBIP',
    rvcp: 'ORIGA',
    navChk: 'GASSO',
    exit: 'DOLKO',
    altitudes: 'FL250/FL300',
    freq: '301.500',
    centre: 'Brisbane Centre',
    points: [
      { id: 'NOBIP', lat: -17.0, lon: 150.29833 },
      { id: 'ORIGA', lat: -18.155, lon: 150.70167 },
      { id: 'GASSO', lat: -20.0, lon: 151.34 },
      { id: 'VEGDI', lat: -22.57167, lon: 152.31389 },
      { id: 'DOLKO', lat: -24.0, lon: 152.87167 },
    ],
  },
  {
    name: 'W953 (North)',
    rvip: 'DOLKO',
    rvcp: 'VEGDI',
    navChk: 'GASSO',
    exit: 'NOBIP',
    altitudes: 'FL250/FL300',
    freq: '301.500',
    centre: 'Brisbane Centre',
    points: [
      { id: 'DOLKO', lat: -24.0, lon: 152.87167 },
      { id: 'VEGDI', lat: -22.57167, lon: 152.31389 },
      { id: 'GASSO', lat: -20.0, lon: 151.34 },
      { id: 'ORIGA', lat: -18.155, lon: 150.70167 },
      { id: 'NOBIP', lat: -17.0, lon: 150.29833 },
    ],
  },
  {
    name: 'W954 (East)',
    rvip: 'CFS',
    rvcp: 'GALON',
    navChk: 'POSUM',
    exit: 'LADUR',
    altitudes: 'FL250/FL300',
    freq: '301.500',
    centre: 'Brisbane Centre',
    points: [
      { id: 'CFS', lat: -30.3195, lon: 153.12089 },
      { id: 'GALON', lat: -30.63464, lon: 154.53344 },
      { id: 'POSUM', lat: -31.09814, lon: 156.78347 },
      { id: 'LHI', lat: -31.52892, lon: 159.07294 },
      { id: 'LADUR', lat: -31.73333, lon: 160.24167 },
    ],
  },
  {
    name: 'W954 (West)',
    rvip: 'LADUR',
    rvcp: 'LHI',
    navChk: 'POSUM',
    exit: 'CFS',
    altitudes: 'FL250/FL300',
    freq: '301.500',
    centre: 'Brisbane Centre',
    points: [
      { id: 'LADUR', lat: -31.73333, lon: 160.24167 },
      { id: 'LHI', lat: -31.52892, lon: 159.07294 },
      { id: 'POSUM', lat: -31.09814, lon: 156.78347 },
      { id: 'GALON', lat: -30.63464, lon: 154.53344 },
      { id: 'CFS', lat: -30.3195, lon: 153.12089 },
    ],
  },
];

/**
 * Military AAR and AEW&C airspace anchor waypoints, by the base whose airspace
 * they belong to. Anchor refuelling orbits on these; the E-7A works the same
 * airspace, which is why the handbook publishes them as one set.
 *
 * "EAXA" is the East Australian Exercise Area, off the NSW south coast — it is
 * airspace rather than a base, and no RAAFv squadron lives there.
 */
export const AAR_ANCHORS: Record<string, Waypoint[]> = {
  Amberley: [
    { id: 'AMX100', lat: -26.26167, lon: 153.49833 },
    { id: 'AMX101', lat: -24.82833, lon: 155.035 },
    { id: 'AMX102', lat: -25.65833, lon: 155.9 },
    { id: 'AMX103', lat: -26.77833, lon: 153.89167 },
    { id: 'AMX104', lat: -27.775, lon: 154.74167 },
    { id: 'AMX105', lat: -27.22, lon: 154.74167 },
    { id: 'AMX106', lat: -26.55667, lon: 155.78167 },
    { id: 'AMX107', lat: -26.26333, lon: 156.50833 },
    { id: 'AMX108', lat: -27.27667, lon: 157.51833 },
    { id: 'AMX109', lat: -28.83667, lon: 156.63167 },
    { id: 'AMX110', lat: -28.87, lon: 153.82833 },
    { id: 'AMX111', lat: -28.48667, lon: 153.96 },
    { id: 'AMX112', lat: -28.56333, lon: 154.155 },
    { id: 'AMX113', lat: -29.22333, lon: 155.12 },
    { id: 'AMX114', lat: -30.47, lon: 154.43167 },
    { id: 'AMX115', lat: -30.315, lon: 153.49167 },
    { id: 'AMX116', lat: -29.65667, lon: 153.62667 },
    { id: 'AMX117', lat: -29.37, lon: 150.155 },
    { id: 'AMX118', lat: -28.16667, lon: 149.8 },
    { id: 'AMX125', lat: -28.475, lon: 149.89 },
    { id: 'AMX126', lat: -28.14167, lon: 151.06 },
    { id: 'AMX127', lat: -28.32833, lon: 151.14667 },
    { id: 'AMX128', lat: -28.59167, lon: 151.34333 },
    { id: 'AMX129', lat: -28.74167, lon: 151.495 },
    { id: 'AMX130', lat: -26.96, lon: 149.735 },
    { id: 'AMX131', lat: -27.295, lon: 150.895 },
    { id: 'AMX132', lat: -27.475, lon: 150.885 },
    { id: 'AMX133', lat: -27.75, lon: 150.92667 },
    { id: 'AMX134', lat: -28.01833, lon: 151.00333 },
    { id: 'AMX135', lat: -28.14167, lon: 151.06 },
    { id: 'AMX136', lat: -28.475, lon: 149.89 },
    { id: 'AMX137', lat: -27.06333, lon: 149.03 },
    { id: 'AMX138', lat: -26.96, lon: 149.735 },
    { id: 'AMX200', lat: -25.115, lon: 155.33167 },
    { id: 'AMX201', lat: -24.82833, lon: 155.035 },
    { id: 'AMX202', lat: -24.14, lon: 154.33 },
    { id: 'AMX203', lat: -23.765, lon: 154.79167 },
    { id: 'AMX204', lat: -24.76167, lon: 155.765 },
    { id: 'AMX205', lat: -27.27667, lon: 157.51833 },
    { id: 'AMX206', lat: -26.28, lon: 156.52333 },
    { id: 'AMX207', lat: -25.93667, lon: 156.94167 },
    { id: 'AMX208', lat: -26.91833, lon: 157.95 },
    { id: 'AMX209', lat: -29.86167, lon: 156.595 },
    { id: 'AMX210', lat: -30.99333, lon: 155.97167 },
    { id: 'AMX211', lat: -30.775, lon: 155.44833 },
    { id: 'AMX212', lat: -29.645, lon: 156.07667 },
    { id: 'AMX213', lat: -27.58667, lon: 149.12333 },
    { id: 'AMX214', lat: -27.495, lon: 149.76333 },
    { id: 'AMX215', lat: -28.81667, lon: 149.99 },
    { id: 'AMX216', lat: -28.90667, lon: 149.36167 },
    { id: 'AMX900', lat: -24.76167, lon: 155.765 },
    { id: 'AMX901', lat: -25.93667, lon: 156.94167 },
    { id: 'AMX902', lat: -26.28, lon: 156.52333 },
    { id: 'AMX903', lat: -25.115, lon: 155.33167 },
    { id: 'AMX905', lat: -29.46833, lon: 149.465 },
    { id: 'AM11C', lat: -26.10167, lon: 154.8 },
    { id: 'AM13C', lat: -27.115, lon: 155.905 },
    { id: 'AM15C', lat: -29.40833, lon: 154.67833 },
    { id: 'AM17C', lat: -28.58333, lon: 150.99 },
    { id: 'AM19C', lat: -27.68667, lon: 150.75333 },
    { id: 'AM22C', lat: -24.85333, lon: 155.24 },
    { id: 'AM24C', lat: -27.01833, lon: 157.41667 },
    { id: 'AM26C', lat: -30.05333, lon: 156.385 },
    { id: 'AM28C', lat: -27.82167, lon: 149.26 },
    { id: 'AM83C', lat: -25.00333, lon: 155.88167 },
    { id: 'AM84C', lat: -29.22333, lon: 149.51667 },
  ],
  Darwin: [
    { id: 'DNX900', lat: -9.54167, lon: 132.10333 },
    { id: 'DNX901', lat: -10.52167, lon: 133.465 },
    { id: 'DNX902', lat: -11.07667, lon: 133.05833 },
    { id: 'DNX903', lat: -10.04833, lon: 131.73167 },
    { id: 'DNX904', lat: -14.26667, lon: 127.94833 },
    { id: 'DNX905', lat: -13.84, lon: 128.38833 },
    { id: 'DNX906', lat: -14.98667, lon: 129.64333 },
    { id: 'DNX907', lat: -15.455, lon: 129.165 },
    { id: 'DNX908', lat: -11.91167, lon: 127.43 },
    { id: 'DNX909', lat: -11.855, lon: 128.07167 },
    { id: 'DNX910', lat: -13.52667, lon: 128.23167 },
    { id: 'DNX911', lat: -13.58333, lon: 127.57833 },
    { id: 'DN81C', lat: -9.75667, lon: 132.25833 },
    { id: 'DN82C', lat: -14.15, lon: 128.43333 },
    { id: 'DN83C', lat: -12.125, lon: 127.875 },
  ],
  EAXA: [
    { id: 'NWX900', lat: -36.03667, lon: 153.57 },
    { id: 'NWX901', lat: -37.22, lon: 152.10833 },
    { id: 'NWX902', lat: -36.77167, lon: 151.555 },
    { id: 'NWX903', lat: -35.485, lon: 152.885 },
    { id: 'NWX904', lat: -35.28333, lon: 150.57 },
    { id: 'NWX905', lat: -36.945, lon: 150.75 },
    { id: 'NWX906', lat: -36.98833, lon: 150.12667 },
    { id: 'NWX907', lat: -35.325, lon: 149.95833 },
    { id: 'NW81C', lat: -36.15667, lon: 153.28167 },
    { id: 'NW82C', lat: -35.54, lon: 150.49167 },
  ],
  Edinburgh: [
    { id: 'EDX100', lat: -30.30503, lon: 143.43706 },
    { id: 'IBODA', lat: -32.02656, lon: 145.31808 },
    { id: 'EDX101', lat: -30.35664, lon: 145.36203 },
    { id: 'ED01C', lat: -30.58333, lon: 144.75 },
    { id: 'EDX102', lat: -31.97331, lon: 143.35911 },
  ],
  Tindal: [
    { id: 'TNX101', lat: -14.0, lon: 130.37333 },
    { id: 'TNX102', lat: -13.42333, lon: 130.595 },
    { id: 'TNX103', lat: -13.36, lon: 131.38167 },
    { id: 'TNX104', lat: -14.0, lon: 131.82833 },
    { id: 'TNX900', lat: -14.70833, lon: 135.59833 },
    { id: 'TNX901', lat: -16.29333, lon: 135.02833 },
    { id: 'TNX902', lat: -16.08333, lon: 134.40333 },
    { id: 'TNX909', lat: -13.39, lon: 130.56167 },
    { id: 'TNX910', lat: -14.95833, lon: 129.95833 },
    { id: 'TNX911', lat: -14.78167, lon: 129.47667 },
    { id: 'TNX912', lat: -17.02944, lon: 129.72028 },
    { id: 'TNX913', lat: -17.03139, lon: 132.37667 },
    { id: 'TNX914', lat: -17.53167, lon: 132.37667 },
    { id: 'TNX915', lat: -17.53167, lon: 129.72028 },
  ],
  Townsville: [
    { id: 'TLX100', lat: -20.19833, lon: 144.895 },
    { id: 'TLX101', lat: -19.445, lon: 144.655 },
    { id: 'TLX102', lat: -19.365, lon: 145.53167 },
    { id: 'TLX103', lat: -19.31667, lon: 146.02833 },
    { id: 'TLX104', lat: -19.58333, lon: 146.075 },
    { id: 'TLX105', lat: -19.75167, lon: 146.21 },
    { id: 'TLX106', lat: -19.86667, lon: 146.61667 },
    { id: 'TLX107', lat: -20.02, lon: 145.83333 },
    { id: 'TLX108', lat: -18.24167, lon: 144.93667 },
    { id: 'TLX109', lat: -18.30333, lon: 145.20667 },
    { id: 'TLX110', lat: -18.64333, lon: 145.70167 },
    { id: 'TLX111', lat: -19.1, lon: 146.16667 },
    { id: 'TLX900', lat: -20.03333, lon: 144.15833 },
    { id: 'TLX901', lat: -18.35833, lon: 144.045 },
    { id: 'TLX902', lat: -18.29833, lon: 144.9 },
    { id: 'TLX903', lat: -19.99167, lon: 144.79167 },
    { id: 'TL11C', lat: -19.60333, lon: 145.09 },
    { id: 'TL12C', lat: -18.56833, lon: 145.20167 },
    { id: 'TL81C', lat: -18.585, lon: 144.5 },
  ],
  Williamtown: [
    { id: 'WM11C', lat: -30.92833, lon: 153.85667 },
    { id: 'WM18C', lat: -31.56667, lon: 153.39167 },
    { id: 'WM19C', lat: -31.66833, lon: 153.445 },
    { id: 'WM20C', lat: -32.655, lon: 153.11667 },
    { id: 'WM21C', lat: -33.08833, lon: 154.25333 },
    { id: 'WM22C', lat: -31.96, lon: 150.625 },
    { id: 'WM23C', lat: -30.76167, lon: 150.03 },
    { id: 'WM87C', lat: -31.48, lon: 155.86833 },
    { id: 'WM88C', lat: -29.71167, lon: 149.71 },
    { id: 'WM89C', lat: -32.01, lon: 155.57833 },
    { id: 'WM92C', lat: -30.945, lon: 155.03333 },
    { id: 'WM93C', lat: -32.77, lon: 155.22667 },
    { id: 'WM94C', lat: -31.31, lon: 152.99333 },
    { id: 'WMX300', lat: -30.72583, lon: 153.4075 },
    { id: 'WMX302', lat: -32.01694, lon: 155.10167 },
    { id: 'WMX303', lat: -31.29, lon: 153.13972 },
    { id: 'WMX304', lat: -32.9175, lon: 154.57944 },
    { id: 'WMX305', lat: -32.48806, lon: 153.41111 },
    { id: 'WMX306', lat: -32.21611, lon: 152.69167 },
    { id: 'WMX307', lat: -33.81833, lon: 152.76056 },
    { id: 'WMX308', lat: -33.815, lon: 152.11139 },
    { id: 'WMX309', lat: -33.65722, lon: 152.035 },
    { id: 'WMX310', lat: -33.19833, lon: 151.97056 },
    { id: 'WMX311', lat: -32.79722, lon: 151.83306 },
    { id: 'WMX312', lat: -32.70528, lon: 152.315 },
    { id: 'WMX313', lat: -32.67722, lon: 152.45944 },
    { id: 'WMX314', lat: -33.81528, lon: 154.04722 },
  ],
};
