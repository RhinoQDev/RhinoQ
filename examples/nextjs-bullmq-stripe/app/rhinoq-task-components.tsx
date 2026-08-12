'use client';

import * as React from 'react';
import { createRhinoQComponents } from '@rhinoq/node/react';

/** Shared once by every Task page; backend-only code never imports React. */
export const { RhinoQTaskList, RhinoQTaskDetail, RhinoQProgress } =
  createRhinoQComponents(React);
